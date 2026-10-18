import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice } from '../components';
import { usePrivateDraft } from '../offline';
import type { RecordItem } from '../types';

const maximumFileBytes = 512000;
const pageSize = 10;
type FileFormat = 'geojson' | 'kml';
type SourceOrigin = 'my_file' | 'public_reference';
type Geometry = { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
type PreviewRow = { id: string; name: string; crop: string | null; external_id: string | null; geometry: Geometry; geometry_summary: Record<string, unknown> | string | null; warnings: (string | { message: string })[] };
type PreviewData = { farm_id: string; farm_revision: number; filename: string; format: FileFormat; sha256: string; source_year: number | null; source_origin: SourceOrigin; status: 'preview' | 'proposed'; rows: PreviewRow[]; proposal_id?: string };
type Preview = RecordItem<PreviewData>;
type FileStamp = { name: string; size: number; lastModified: number; farmRevision: number };
type UploadDraft = { previewId: string; previewRevision: number; uploadAttempt: string; stamp: FileStamp | null; yearMode: '' | 'known' | 'unknown'; year: string; origin: '' | SourceOrigin };
type Choices = { selectedIds: string[]; note: string; attempt: string; proposalId: string; proposalRevision: number };
type Props = { farm: RecordItem; onProposed: (proposal: RecordItem) => void; disabled?: boolean };
const blankUpload = (): UploadDraft => ({ previewId: '', previewRevision: 0, uploadAttempt: crypto.randomUUID(), stamp: null, yearMode: '', year: '', origin: '' });
const blankChoices = (): Choices => ({ selectedIds: [], note: '', attempt: crypto.randomUUID(), proposalId: '', proposalRevision: 0 });
const sameFile = (stamp: FileStamp | null, file: File) => stamp !== null && stamp.name === file.name && stamp.size === file.size && stamp.lastModified === file.lastModified;
const proposalHref = (farmId: string, id: string, revision: number) => `/app/fields/${encodeURIComponent(farmId)}?${new URLSearchParams({ proposal_id: id, expected_revision: String(revision) })}#boundaries-${farmId}`;

function SuppliedOutline({ geometry, name }: { geometry: Geometry; name: string }) {
  const id = useId();
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates as number[][][]] : geometry?.type === 'MultiPolygon' ? geometry.coordinates as number[][][][] : [];
  const valid = polygons.length > 0 && polygons.every(polygon => Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring => Array.isArray(ring) && ring.length >= 4 && ring.every(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))));
  if (!valid) return <p>The returned outline cannot be displayed. Check the saved preview before continuing.</p>;
  let west = Infinity; let east = -Infinity; let south = Infinity; let north = -Infinity;
  for (const polygon of polygons) for (const ring of polygon) for (const point of ring) { west = Math.min(west, point[0]); east = Math.max(east, point[0]); south = Math.min(south, point[1]); north = Math.max(north, point[1]); }
  const longitude = (west + east) / 2; const latitude = (south + north) / 2;
  const cosine = Math.max(0.001, Math.cos(latitude * Math.PI / 180));
  const scale = Math.min(320 / Math.max((east - west) * cosine, 0.000001), 170 / Math.max(north - south, 0.000001));
  const paths = polygons.map(polygon => polygon.map(ring => ring.map((point, index) => `${index ? 'L' : 'M'}${180 + (point[0] - longitude) * cosine * scale} ${105 - (point[1] - latitude) * scale}`).join(' ') + ' Z').join(' '));
  return <figure style={{ margin: '1rem 0' }}><svg viewBox="0 0 360 210" role="img" aria-labelledby={id} style={{ display: 'block', width: '100%', maxHeight: 240, background: 'var(--farm-soft)', border: '1px solid var(--line)', borderRadius: 14 }}><title id={id}>Outline supplied in the file for {name}</title>{paths.map((path, index) => <path key={index} d={path} style={{ fill: 'var(--farm)', stroke: 'var(--farm-text)' }} fillOpacity=".3" fillRule="evenodd" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}</svg><figcaption className="muted">Saved file outline</figcaption></figure>;
}

function GeometrySummary({ value }: { value: PreviewRow['geometry_summary'] }) {
  if (typeof value === 'string') return <p>{value}</p>;
  if (!value || typeof value !== 'object') return <p className="muted">No geometry summary was supplied by the workspace.</p>;
  const labels: Record<string, string> = { type: 'Outline type', geometry_type: 'Outline type', polygon_count: 'Separate outline parts', ring_count: 'Outline rings', vertex_count: 'Supplied points', point_count: 'Supplied points', area_ha: 'Area returned by the file check, ha', approximate_area_ha: 'Approximate area returned by the file check, ha', bounds: 'Supplied coordinate bounds', bbox: 'Supplied coordinate bounds' };
  const items = Object.entries(value).filter(([key, content]) => key in labels && (typeof content === 'string' || typeof content === 'number' || Array.isArray(content) && content.every(item => typeof item === 'number')));
  return <>{items.length ? <dl className="detail-grid">{items.map(([key, content]) => <div key={key}><dt>{labels[key]}</dt><dd>{Array.isArray(content) ? content.join(', ') : String(content)}</dd></div>)}</dl> : <p className="muted">The outline is shown above. No area or national identifier has been calculated here.</p>}{Array.isArray(value.warnings) && value.warnings.filter((warning): warning is string => typeof warning === 'string').map((warning, index) => <Notice kind="warning" key={index}>{warning}</Notice>)}</>;
}

export function FieldFileImport(props: Props) {
  const { session } = useSession();
  const scope = `${session?.user.id}/${session?.workspace.id}/${session?.workspace.role}/${session?.workspace.permissions?.join(',')}/${session?.workspace.farm_ids?.join(',')}`;
  return <FileImportForm key={`${scope}/${props.farm.id}`} {...props} scope={scope} />;
}

function FileImportForm({ farm, onProposed, disabled = false, scope }: Props & { scope: string }) {
  const { session } = useSession();
  const upload = usePrivateDraft<UploadDraft>(`field-file-import/${farm.id}/preview`, blankUpload());
  const choices = usePrivateDraft<Choices>(`field-file-import/${farm.id}/${upload.value.previewId || 'new'}/choices`, blankChoices());
  const [file, setFile] = useState<File | null>(null); const fileInput = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<{ id: string; record: Preview } | null>(null);
  const [busy, setBusy] = useState<'preview' | 'load' | 'propose' | 'proposal' | ''>(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [page, setPage] = useState(0); const [acknowledged, setAcknowledged] = useState(false);
  const mounted = useRef(true); const generation = useRef(0); const request = useRef<AbortController | null>(null);
  const binding = `${scope}/${farm.id}/${farm.revision}/${disabled}`; const currentBinding = useRef(binding); currentBinding.current = binding;
  const preview = saved?.id === upload.value.previewId ? saved.record : null;
  const canWrite = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  const blocked = disabled || !canWrite;
  const ready = upload.ready && choices.ready;
  const current = (captured: string, attempt: number) => mounted.current && currentBinding.current === captured && generation.current === attempt;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; request.current?.abort(); }; }, []);
  useEffect(() => { generation.current += 1; request.current?.abort(); request.current = null; setBusy(''); setAcknowledged(false); }, [binding]);

  function validatePreview(record: Preview, id?: string) {
    if (record.kind !== 'field_imports' || id && record.id !== id || record.workspace_id !== session?.workspace.id || record.data.farm_id !== farm.id || !Number.isInteger(record.revision) || record.revision < 1 || !Array.isArray(record.data.rows) || record.data.rows.length < 1 || record.data.rows.length > 100) throw new Error('The workspace did not return a complete preview for this farm. Reopen the saved preview before continuing.');
    if (!record.data.rows.every(row => typeof row.id === 'string' && typeof row.name === 'string' && Array.isArray(row.warnings))) throw new Error('Some preview rows are unavailable. This preview cannot be proposed until it can be read completely.');
  }
  async function loadPreview() {
    const id = upload.value.previewId; if (!id || !upload.ready) return;
    const captured = binding; const attempt = ++generation.current; request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy('load'); setError(''); setAcknowledged(false);
    try { const response = await api.downloadResponse(`/field-imports/${encodeURIComponent(id)}`, { signal: controller.signal }); const record = await response.json() as Preview; validatePreview(record, id); if (!current(captured, attempt)) return; setSaved({ id, record }); setPage(0); }
    catch (failure) { if (current(captured, attempt)) setError(errorMessage(failure)); }
    finally { if (request.current === controller) request.current = null; if (current(captured, attempt)) setBusy(''); }
  }
  useEffect(() => { setSaved(null); setPage(0); if (upload.ready && upload.value.previewId) void loadPreview(); }, [upload.ready, upload.value.previewId]);

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] || null; setAcknowledged(false); setError(''); setMessage('');
    if (!selected) { setFile(null); return; }
    if (!/\.(?:geojson|json|kml)$/i.test(selected.name) || selected.size < 1 || selected.size > maximumFileBytes) { setFile(null); event.currentTarget.value = ''; setError('Choose one GeoJSON (.geojson or .json) or KML (.kml) file, no larger than 512,000 bytes. ZIP and shapefile uploads are not supported here.'); return; }
    setFile(selected);
    if (!sameFile(upload.value.stamp, selected)) upload.setValue(previous => ({ ...previous, uploadAttempt: crypto.randomUUID(), stamp: { name: selected.name, size: selected.size, lastModified: selected.lastModified, farmRevision: farm.revision } }));
  }
  function sourceChange(next: Partial<Pick<UploadDraft, 'yearMode' | 'year' | 'origin'>>) { upload.setValue(previous => ({ ...previous, ...next, uploadAttempt: crypto.randomUUID() })); setAcknowledged(false); setError(''); }
  function editChoices(next: Partial<Choices>) { choices.setValue(previous => ({ ...previous, ...next, attempt: crypto.randomUUID() })); setAcknowledged(false); setError(''); }

  async function makePreview(event: FormEvent) {
    event.preventDefault(); if (!file || !ready || blocked || busy || !upload.value.stamp) return;
    const captured = binding; const attempt = ++generation.current; const controller = new AbortController(); request.current = controller;
    setBusy('preview'); setError(''); setMessage('');
    try {
      if (!upload.value.origin || !upload.value.yearMode) throw new Error('Choose where the file came from and whether its source year is known.');
      const sourceYear = upload.value.yearMode === 'unknown' ? null : Number(upload.value.year);
      if (sourceYear !== null && (!upload.value.year.trim() || !Number.isSafeInteger(sourceYear) || sourceYear < 1900 || sourceYear > 2200)) throw new Error('Enter the actual source year from 1900 to 2200, or explicitly choose that it is not known.');
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength < 1 || bytes.byteLength > maximumFileBytes) throw new Error('This file exceeds the 512,000-byte preview limit.');
      let contents: string;
      try { contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error('This file is not valid UTF-8 text. Export it as UTF-8 GeoJSON or KML and choose the exported file.'); }
      if (!current(captured, attempt)) return;
      const format: FileFormat = /\.kml$/i.test(file.name) ? 'kml' : 'geojson';
      const record = await api.post<Preview>(`/farms/${farm.id}/field-imports`, { expected_farm_revision: upload.value.stamp.farmRevision, filename: file.name, format, contents, source_year: sourceYear, source_origin: upload.value.origin }, { idempotencyKey: upload.value.uploadAttempt, signal: controller.signal });
      validatePreview(record);
      if (record.data.farm_revision !== upload.value.stamp.farmRevision) throw new Error('This preview belongs to a different saved farm version. Your file has not been rebased.');
      if (!current(captured, attempt)) return;
      upload.setValue(previous => ({ ...previous, previewId: record.id, previewRevision: record.revision })); setSaved({ id: record.id, record }); setFile(null); if (fileInput.current) fileInput.current.value = ''; setPage(0); setMessage('The file preview is saved. Choose which fields to include; existing fields have not been changed.');
    } catch (failure) { if (current(captured, attempt)) setError(`${errorMessage(failure)}${failure instanceof ApiError && failure.status === 409 ? ' The saved farm or this retry changed. No automatic rebase was made.' : ''}`); }
    finally { if (request.current === controller) request.current = null; if (current(captured, attempt)) setBusy(''); }
  }

  async function openProposal(id: string) {
    if (!id || busy || disabled) return; const captured = binding; const attempt = ++generation.current; const controller = new AbortController(); request.current = controller; setBusy('proposal'); setError('');
    try { const record = await (await api.downloadResponse(`/field-proposals/${encodeURIComponent(id)}`, { signal: controller.signal })).json() as RecordItem; if (record.id !== id || record.kind !== 'field_change_proposals' || record.workspace_id !== session?.workspace.id || record.data.farm_id !== farm.id) throw new Error('The saved proposal is not available in this farm.'); if (!current(captured, attempt)) return; choices.setValue(previous => ({ ...previous, proposalId: record.id, proposalRevision: record.revision })); setMessage('The saved field proposal is ready to review below. This file cannot create a second batch.'); try { onProposed(record); } catch { setError('The proposal is saved, but the field review could not refresh. Use its exact saved-proposal link below.'); } }
    catch (failure) { if (current(captured, attempt)) setError(errorMessage(failure)); }
    finally { if (request.current === controller) request.current = null; if (current(captured, attempt)) setBusy(''); }
  }
  async function propose(event: FormEvent) {
    event.preventDefault(); if (!preview || !ready || blocked || busy || !acknowledged || preview.data.status !== 'preview' || preview.data.farm_revision !== farm.revision || preview.revision !== upload.value.previewRevision || choices.value.selectedIds.length < 1 || choices.value.selectedIds.length > 20 || !choices.value.note.trim()) return;
    if (choices.value.selectedIds.some(id => !preview.data.rows.some(row => row.id === id))) { setError('Some selected fields are no longer in this saved preview. Remove those selections explicitly before continuing.'); return; }
    const captured = binding; const attempt = ++generation.current; const controller = new AbortController(); request.current = controller; setBusy('propose'); setError(''); setMessage('');
    try {
      const result = await api.post<{ import: Preview; proposal: RecordItem }>(`/field-imports/${preview.id}/propose`, { expected_revision: preview.revision, expected_farm_revision: preview.data.farm_revision, selected_ids: choices.value.selectedIds, note: choices.value.note, acknowledged: true }, { idempotencyKey: choices.value.attempt, signal: controller.signal });
      validatePreview(result.import, preview.id);
      if (result.proposal.kind !== 'field_change_proposals' || result.proposal.workspace_id !== session?.workspace.id || result.proposal.data.farm_id !== farm.id || result.import.data.proposal_id !== result.proposal.id) throw new Error('The saved proposal response does not match this farm preview. Reopen the preview to recover its saved result.');
      if (!current(captured, attempt)) return;
      setSaved({ id: result.import.id, record: result.import }); choices.setValue(previous => ({ ...previous, proposalId: result.proposal.id, proposalRevision: result.proposal.revision })); setAcknowledged(false); setMessage('A proposed field change is saved. Review it through the normal field-change controls before confirming anything. Existing fields were not overwritten by this import.'); try { onProposed(result.proposal); } catch { setError('The proposal is saved, but the field review could not refresh. Use its exact saved-proposal link below.'); }
    } catch (failure) { if (current(captured, attempt)) { setAcknowledged(false); setError(`${errorMessage(failure)} Your choices are retained. Reopen the saved preview before retrying if the result is uncertain.`); } }
    finally { if (request.current === controller) request.current = null; if (current(captured, attempt)) setBusy(''); }
  }

  const rows = preview?.data.rows || []; const pages = Math.max(1, Math.ceil(rows.length / pageSize)); const currentPage = Math.min(page, pages - 1); const shownRows = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const unavailable = choices.value.selectedIds.filter(id => !rows.some(row => row.id === id));
  const used = preview?.data.status === 'proposed' || !!preview?.data.proposal_id || !!choices.value.proposalId;
  const savedProposalId = choices.value.proposalId || preview?.data.proposal_id || '';
  const stale = !!preview && (preview.data.farm_revision !== farm.revision || preview.revision !== upload.value.previewRevision && !used);
  return <section className="card" aria-labelledby={`field-file-title-${farm.id}`}><h3 id={`field-file-title-${farm.id}`}>Add fields from a file</h3><p>Bring a GeoJSON or KML file, check its fields, then choose up to 20 for one proposed batch. Existing fields stay unchanged until you review and confirm the proposed change separately.</p><Notice>A public reference file does not prove ownership or entitlement. No official identifier or authority acceptance is inferred from this import.</Notice>
    <p className="muted">File contents are not kept in browser draft storage. If you leave before the preview is saved, choose the file again. Saved preview IDs and your choices stay private to this account and workspace.</p>
    {!ready && <p role="status">Opening your private preview choices…</p>}{(upload.saving || choices.saving) && <p role="status">Saving preview IDs and choices privately on this device…</p>}{(upload.error || choices.error) && <Notice kind="warning">{upload.error || choices.error} Keep this page open until your choices are saved.</Notice>}{error && <Notice kind="error">{error}</Notice>}{message && <Notice>{message}</Notice>}{blocked && <p>Your current permission or the open field action does not allow a new proposal here. Saved previews can still be reopened through your permitted farm access.</p>}
    {!upload.value.previewId ? <form onSubmit={makePreview} className="stack"><fieldset disabled={!ready || blocked || !!busy}>
      <Field label="Choose a GeoJSON or KML file" hint="One UTF-8 .geojson, .json or .kml file, up to 512,000 bytes. ZIP and shapefiles are not supported."><input ref={fileInput} type="file" accept=".geojson,.json,.kml" onChange={chooseFile} /></Field>
      {file && <p>{file.name} · {file.size.toLocaleString()} bytes · expected format {/\.kml$/i.test(file.name) ? 'KML' : 'GeoJSON'}. The workspace will validate the full file.</p>}
      <div className="form-grid"><Field label="Where did this file come from?"><select required value={upload.value.origin} onChange={event => sourceChange({ origin: event.target.value as '' | SourceOrigin })}><option value="">Choose the actual source</option><option value="my_file">A file I provide from my records</option><option value="public_reference">A public reference file for comparison</option></select></Field>
        <Field label="Do you know the source year?"><select required value={upload.value.yearMode} onChange={event => sourceChange({ yearMode: event.target.value as UploadDraft['yearMode'], year: '' })}><option value="">Choose what is known</option><option value="unknown">The source year is not known</option><option value="known">The source states its year</option></select></Field>
        {upload.value.yearMode === 'known' && <Field label="Year stated by the source"><input required type="number" step="1" min="1900" max="2200" value={upload.value.year} onChange={event => sourceChange({ year: event.target.value })} /></Field>}
      </div>
      {upload.value.stamp && upload.value.stamp.farmRevision !== farm.revision && <Notice kind="warning">The farm changed after this file was selected. Retrying keeps the original farm version and can recover a preview already saved by that request. Otherwise, check the latest fields and explicitly start another preview. Nothing is silently rebased.</Notice>}
      <Button type="submit" loading={busy === 'preview'} disabled={!file || !upload.value.stamp}>{upload.value.stamp && upload.value.stamp.farmRevision !== farm.revision ? 'Retry original preview request' : 'Check file and save preview'}</Button>
    </fieldset></form> : <div className="stack"><Button variant="secondary" loading={busy === 'load'} disabled={!!busy || !upload.ready} onClick={() => void loadPreview()}>Reopen saved preview</Button>{!preview && !error && <p role="status">Opening the saved file preview…</p>}</div>}
    {preview && choices.ready && <><h4>{preview.data.filename}</h4><p>{rows.length} fields returned by the workspace. Source year: {preview.data.source_year ?? 'not known'} · {preview.data.source_origin === 'public_reference' ? 'Public reference for comparison, not ownership' : 'File supplied from your records'}.</p>{stale && <Notice kind="warning">The farm or saved preview changed. Your selections are retained, but this old preview cannot create a new proposal against a different farm version. Check the latest fields and explicitly start a new preview if needed.</Notice>}{unavailable.length > 0 && <Notice kind="warning">Some retained selections are unavailable in this preview. They have not been silently replaced.<Button variant="secondary" disabled={blocked || !!busy} onClick={() => editChoices({ selectedIds: choices.value.selectedIds.filter(id => !unavailable.includes(id)) })}>Remove unavailable selections</Button></Notice>}
      <p role="status">Showing {currentPage * pageSize + 1} to {currentPage * pageSize + shownRows.length} of {rows.length} fields. {choices.value.selectedIds.length} selected, maximum 20. Choices on other pages remain selected.</p>
      {shownRows.map(row => <article className="panel" key={row.id}><label className="check-row"><input type="checkbox" checked={choices.value.selectedIds.includes(row.id)} disabled={!ready || blocked || !!busy || used || stale || !choices.value.selectedIds.includes(row.id) && choices.value.selectedIds.length >= 20} onChange={event => editChoices({ selectedIds: event.target.checked ? [...choices.value.selectedIds, row.id] : choices.value.selectedIds.filter(id => id !== row.id) })} /><strong>{row.name || 'Name not supplied'}</strong></label><p>Crop in file: {row.crop ?? 'not supplied'} · Identifier in file: {row.external_id ?? 'not supplied'}. Any supplied identifier remains unverified.</p><SuppliedOutline geometry={row.geometry} name={row.name} /><GeometrySummary value={row.geometry_summary} />{row.warnings.map((warning, index) => <Notice kind="warning" key={index}>{typeof warning === 'string' ? warning : warning.message || 'The workspace returned a warning that could not be displayed. Reopen the preview before continuing.'}</Notice>)}</article>)}
      <div className="actions"><Button variant="secondary" disabled={currentPage === 0} onClick={() => setPage(Math.max(0, currentPage - 1))}>Previous fields</Button><Button variant="secondary" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>More fields</Button></div>
      {used ? <Notice><p>This preview has already been used for one proposed batch. It cannot add another batch.</p>{savedProposalId && <Button variant="secondary" disabled={!!busy || disabled} loading={busy === 'proposal'} onClick={() => void openProposal(savedProposalId)}>Open saved field proposal for review</Button>}{choices.value.proposalId && choices.value.proposalRevision > 0 && <p><Link to={proposalHref(farm.id, choices.value.proposalId, choices.value.proposalRevision)}>Review this exact saved proposal</Link></p>}</Notice> : <form className="stack" onSubmit={propose}><fieldset disabled={!ready || blocked || !!busy || stale}><Field label="What did you check before adding these fields?"><textarea required maxLength={4000} value={choices.value.note} onChange={event => editChoices({ note: event.target.value })} /></Field><label className="check-row"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I checked these selected fields against my records. I understand that this creates a proposal, not an official update or proof of ownership.</label><Button type="submit" loading={busy === 'propose'} disabled={!acknowledged || choices.value.selectedIds.length < 1 || choices.value.selectedIds.length > 20 || unavailable.length > 0}>Save selected fields as one proposal</Button></fieldset></form>}
      <details><summary>Saved preview details</summary><p>Preview identity: {preview.id} · revision {preview.revision} · source farm revision {preview.data.farm_revision}</p><p style={{ overflowWrap: 'anywhere' }}>File SHA-256 returned by the workspace: {preview.data.sha256}</p></details>
    </>}
    {(upload.value.previewId || upload.value.stamp) && <p><Button variant="ghost" disabled={!!busy || !ready || blocked} onClick={() => { generation.current += 1; setAcknowledged(false); upload.setValue(blankUpload()); setSaved(null); setFile(null); setError(''); setMessage('Choose the new file and its source details. Earlier saved previews and their private choices have not been overwritten.'); if (fileInput.current) fileInput.current.value = ''; }}>Start another file preview</Button></p>}
  </section>;
}
