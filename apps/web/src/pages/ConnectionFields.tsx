import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { Button, Field, Loading, Notice } from '../components';
import type { Page, RecordItem } from '../types';
import type { FieldGeometry, FieldPoint } from './FieldsMap';
import type { ParcelMapBounds } from '../maps/ParcelMap';

const ParcelMap = lazy(() => import('../maps/ParcelMap').then(module => ({ default: module.ParcelMap })));
type Connection = RecordItem<{ farm_id: string; capability_id: string; status: string; title: string; credentials_present: boolean }>;
type Feature = { id?: string | number; type: string; geometry?: FieldGeometry; properties?: Record<string, unknown> };
type Read = RecordItem<{ farm_id: string; connection_id: string; read_at: string; result: { features?: Feature[]; truncated?: boolean } }>;
type Preview = RecordItem<{ farm_id: string; farm_revision: number; status: string; source_year: number | null; proposal_id?: string; connection_source?: { connection_id: string }; rows: { id: string; name: string; geometry_summary: { approximate_area_ha: number | null }; warnings: (string | { message?: string })[] }[] }>;
const unchanged = () => {};
function outline(value: unknown): value is FieldGeometry {
  if (!value || typeof value !== 'object' || !('type' in value) || !('coordinates' in value)) return false;
  return ['Polygon', 'MultiPolygon'].includes(String(value.type)) && Array.isArray(value.coordinates);
}
function viewProblem(bbox: ParcelMapBounds | null) {
  if (!bbox) return 'Move the map to the fields you want to find.';
  const [west, south, east, north] = bbox;
  if (!bbox.every(Number.isFinite) || !(3 <= west && west < east && east <= 8 && 50 <= south && south < north && north <= 54)) return 'Zoom in to an area inside the Netherlands.';
  if ((east - west) * (north - south) > .25) return 'Zoom in a little more before searching.';
  return '';
}
function label(feature: Feature, index: number) {
  const crop = feature.properties?.gewas;
  return typeof crop === 'string' ? crop : `Public parcel ${index + 1}`;
}

export function ConnectionFields({ farm, connection, ensureConnection, canManage }: { farm: RecordItem; connection?: Connection; ensureConnection: () => Promise<Connection>; canManage: boolean }) {
  const [query, setQuery] = useSearchParams();
  const [bbox, setBbox] = useState<ParcelMapBounds | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [earlier, setEarlier] = useState<Read[]>([]);
  const [readPage, setReadPage] = useState(0);
  const [readTotal, setReadTotal] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copiedProposal, setCopiedProposal] = useState<RecordItem | null>(null);
  const [page, setPage] = useState(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const readKey = query.get('read_id') || '';
  const importKey = query.get('import_id') || '';
  const proposalKey = useRef(crypto.randomUUID());
  const previewKey = useRef(crypto.randomUUID());
  const parcels = (Array.isArray(farm.data.parcels) ? farm.data.parcels : []).filter(parcel => parcel.active !== false);
  const context = parcels.filter(parcel => outline(parcel.geometry)).map(parcel => ({ id: String(parcel.id), label: String(parcel.name || 'Saved field'), geometry: parcel.geometry as FieldGeometry }));
  const point: FieldPoint | null = parcels.find(parcel => parcel.point && Number.isFinite(parcel.point.latitude) && Number.isFinite(parcel.point.longitude))?.point || null;
  const features = Array.isArray(read?.data.result.features) ? read.data.result.features : [];
  const candidates = features.flatMap((feature, index) => outline(feature.geometry) ? [{ id: String(index), label: label(feature, index), geometry: feature.geometry }] : []);
  const problem = viewProblem(bbox);
  const stale = !!preview && preview.data.farm_revision !== farm.revision;
  const used = preview?.data.status === 'proposed';

  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  useEffect(() => {
    if (!connection) return;
    let current = true;
    api.get<Page<Read>>(`/connections/${connection.id}/reads?limit=5&offset=${readPage * 5}`).then(result => {
      if (current) { setEarlier(result.items); setReadTotal(result.total); }
    }).catch(failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [connection?.id, readPage, readKey]);
  useEffect(() => {
    let current = true; setError(''); setSelected([]); setPage(0); setChecked(false); setRead(null); setPreview(null); setCopiedProposal(null);
    if (connection && readKey) api.get<Read>(`/connections/${connection.id}/reads/${encodeURIComponent(readKey)}`).then(record => {
      if (record.data.farm_id !== farm.id || record.data.connection_id !== connection.id) throw new Error('These public parcels belong to a different farm.');
      if (current) setRead(record);
    }).catch(failure => { if (current) setError(errorMessage(failure)); });
    if (connection && importKey) api.get<Preview>(`/field-imports/${encodeURIComponent(importKey)}`).then(record => {
      if (record.data.farm_id !== farm.id || record.data.connection_source?.connection_id !== connection.id) throw new Error('This field preview does not belong to this farm connection.');
      if (current) setPreview(record);
    }).catch(failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [connection?.id, readKey, importKey, farm.id]);

  function locate(values: Record<string, string>) {
    setQuery(previous => { const next = new URLSearchParams(previous); for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); } return next; });
  }
  async function act(name: string, operation: (current: () => boolean) => Promise<void>) {
    if (busy) return; const attempt = ++generation.current; const current = () => alive.current && generation.current === attempt;
    setBusy(name); setError('');
    try { await operation(current); } catch (failure) { if (current()) setError(errorMessage(failure)); }
    finally { if (current()) setBusy(''); }
  }
  function toggle(index: number) {
    setSelected(previous => previous.includes(index) ? previous.filter(value => value !== index) : [...previous, index]);
    setChecked(false); previewKey.current = crypto.randomUUID();
  }
  async function findFields() {
    if (!bbox || problem || !canManage) return;
    await act('read', async current => {
      let route = await ensureConnection(); if (!current()) return;
      if (route.data.status !== 'public_read_ready') route = await api.post<Connection>(`/connections/${route.id}/activate`, { expected_revision: route.revision });
      if (!current()) return;
      const result = await api.post<Read>(`/connections/${route.id}/read`, { bbox, limit: 50 });
      if (current()) { setRead(result); setSelected([]); setPreview(null); locate({ read_id: result.id, import_id: '' }); }
    });
  }
  async function prepareFields() {
    if (!read || !connection || selected.length < 1 || selected.length > 20) return;
    await act('preview', async current => {
      const record = await api.post<Preview>(`/connections/${connection.id}/reads/${read.id}/field-preview`, { expected_read_revision: read.revision, expected_farm_revision: farm.revision, selected_indices: selected }, { idempotencyKey: previewKey.current });
      if (current()) { setPreview(record); setChecked(false); locate({ import_id: record.id }); }
    });
  }
  async function propose() {
    if (!preview || !checked || stale || used || !note.trim() || !canManage) return;
    await act('propose', async current => {
      const result = await api.post<{ import: Preview; proposal: RecordItem }>(`/field-imports/${preview.id}/propose`, { expected_revision: preview.revision, expected_farm_revision: preview.data.farm_revision, selected_ids: preview.data.rows.map(row => row.id), note: note.trim(), acknowledged: true }, { idempotencyKey: proposalKey.current });
      if (current()) { setPreview(result.import); setCopiedProposal(result.proposal); setChecked(false); }
    });
  }
  const proposalId = copiedProposal?.id || preview?.data.proposal_id;
  const proposalHref = proposalId ? `/app/fields/${farm.id}?${new URLSearchParams({ proposal_id: proposalId, ...(copiedProposal ? { expected_revision: String(copiedProposal.revision) } : {}) })}#boundaries-${farm.id}` : '';

  return <section className="paper-section connection-field-reader" aria-labelledby="connection-public">
    <h2 id="connection-public">Find fields on the map</h2><p>Move to your land, then search this area. Your saved fields stay unchanged.</p>
    {error && <Notice kind="error">{error}</Notice>}
    <Suspense fallback={<Loading>Opening the map…</Loading>}><ParcelMap key={farm.id} geometry={null} reference={null} point={point} contextOutlines={context} referenceCandidates={candidates} onReferenceSelect={id => { const index = Number(id); if (Number.isInteger(index) && features[index] && !busy && !preview && (selected.includes(index) || selected.length < 20)) toggle(index); }} readOnly country="NL" mode="edit" sketch={[]} splitLine={[]} onGeometry={unchanged} onSketch={unchanged} onSplitLine={unchanged} onViewportChange={setBbox}/></Suspense>
    <div className="connection-map-action"><p>{problem || 'Searches the visible map only. No farm records or sign-in details are sent to PDOK.'}</p><Button disabled={!!busy || !canManage || !!problem} loading={busy === 'read'} onClick={() => void findFields()}>Find public parcels here</Button></div>
    {read && <><h3>Choose the fields you recognise</h3><p>{features.length} parcels found. {read.data.result.truncated ? 'There are more in this area. Zoom in for a smaller search.' : ''} Read {new Date(read.data.read_at).toLocaleString()}.</p><p className="muted">Public outlines are a starting point, not proof that you farm this land. The source crop may be from an earlier year.</p>
      {!preview && <><div className="connection-candidate-list">{features.slice(page * 10, page * 10 + 10).map((feature, index) => { const position = page * 10 + index; const hasOutline = outline(feature.geometry); return <label className="connection-candidate" key={position}><input type="checkbox" checked={selected.includes(position)} disabled={!!busy || !canManage || !hasOutline || !selected.includes(position) && selected.length >= 20} onChange={() => toggle(position)}/><span><strong>{label(feature, position)}</strong><small>Source year: {String(feature.properties?.jaar ?? 'not supplied')} · Reference: {String(feature.id ?? 'not supplied')}{!hasOutline && ' · No usable outline'}</small></span></label>; })}</div>
      {features.length > 10 && <div className="actions"><Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous parcels</Button><span>Page {page + 1} of {Math.ceil(features.length / 10)}</span><Button variant="secondary" disabled={(page + 1) * 10 >= features.length} onClick={() => setPage(page + 1)}>More parcels</Button></div>}
      <div className="actions"><span>{selected.length} selected, up to 20</span><Button disabled={!canManage || !!busy || selected.length === 0} loading={busy === 'preview'} onClick={() => void prepareFields()}>Review selected outlines</Button></div></>}
    </>}
    {preview && <section className="connection-result"><h3>Check before adding these fields</h3><p>{preview.data.rows.length} outlines. Source year: {preview.data.source_year ?? 'not known'}. Current crop and ownership have not been filled in from the public source.</p>
      <ul className="connection-preview-rows">{preview.data.rows.map(row => <li key={row.id}><strong>{row.name}</strong><span>{row.geometry_summary.approximate_area_ha == null ? 'Area not available' : `About ${row.geometry_summary.approximate_area_ha.toLocaleString()} ha`}</span></li>)}</ul>
      {stale && !used && <Notice kind="warning">The farm changed. Search again and review the current fields before creating a new proposal.</Notice>}
      {used ? <Notice kind="success">The field proposal is saved. <Link to={proposalHref}>Review it alongside your existing fields</Link> before confirming it.</Notice> : <form onSubmit={event => { event.preventDefault(); void propose(); }}><Field label="What did you check?" hint="For example, which land you use and how these outlines match your records."><textarea value={note} maxLength={4000} required disabled={!!busy || !canManage || stale} onChange={event => { setNote(event.target.value); proposalKey.current = crypto.randomUUID(); setChecked(false); }}/></Field><label className="check-row"><input type="checkbox" checked={checked} disabled={!!busy || !canManage || stale} onChange={event => setChecked(event.target.checked)}/>I checked these outlines. Save them as a proposal for review, without changing my fields yet.</label><Button type="submit" loading={busy === 'propose'} disabled={!checked || !note.trim() || !canManage || !!busy || stale}>Save field proposal</Button></form>}
      <Button variant="ghost" disabled={!!busy} onClick={() => { locate({ import_id: '' }); setPreview(null); setChecked(false); }}>Choose different parcels</Button>
    </section>}
    {earlier.length > 0 && <section className="connection-saved-reads"><h3>Previous map searches</h3><ul className="connection-history-list">{earlier.map(item => <li key={item.id}><span>{new Date(item.data.read_at).toLocaleString()} · {item.data.result.features?.length ?? 0} parcels</span><Button variant="ghost" disabled={!!busy} onClick={() => locate({ read_id: item.id, import_id: '' })}>Open search</Button></li>)}</ul>{readTotal > 5 && <div className="actions"><Button variant="secondary" disabled={readPage === 0} onClick={() => setReadPage(readPage - 1)}>Newer searches</Button><Button variant="secondary" disabled={(readPage + 1) * 5 >= readTotal} onClick={() => setReadPage(readPage + 1)}>Older searches</Button></div>}</section>}
    <p><Link to={`/app/fields/${farm.id}`}>Open all field changes and boundary downloads</Link></p>
  </section>;
}
