import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Notice } from '../components';
import type { Page, RecordItem } from '../types';
import type { FieldGeometry } from '../pages/FieldsMap';
import type { IacsFieldReference } from '../pages/IacsReference';

export type MapReferenceCandidate = { id: string; label: string; geometry: FieldGeometry };
export type PublicParcelReferenceProps = {
  farm: RecordItem;
  viewport: [number, number, number, number] | null;
  onCandidates: (candidates: MapReferenceCandidate[]) => void;
  onSelect: (reference: IacsFieldReference) => void;
  selectId?: string | null;
  selectedSource?: string;
};

type Connection = RecordItem<{ farm_id: string; capability_id: string; status: string }>;
type Entry = MapReferenceCandidate & { reference: IacsFieldReference; category: string | null; status: string | null; originalProperties: Record<string, unknown> };
type Read = { scope: string; connection: Connection; id: string; readAt: string; entries: Entry[]; skipped: number; returned: number; truncated: boolean };
const SOURCE = 'https://api.pdok.nl/rvo/gewaspercelen/ogc/v1/collections/brpgewas/items';
const CAPABILITY = 'nl-pdok-brp-public';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, maximum = 200): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
}
function sourceValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'Not supplied';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'object') return String(value) || 'Left blank';
  if (depth >= 3) return 'Further detail retained in the original source';
  if (Array.isArray(value)) return value.map(item => sourceValue(item, depth + 1)).join('; ') || 'None supplied';
  return Object.entries(value).map(([key, item]) => `${key.replaceAll('_', ' ')}: ${sourceValue(item, depth + 1)}`).join('; ');
}
function sourceYear(value: unknown): number | null {
  const year = typeof value === 'number' ? value : typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null;
}
function viewportProblem(view: PublicParcelReferenceProps['viewport']): string | null {
  if (!view || view.length !== 4 || !view.every(Number.isFinite)) return 'Open the map and choose a small area in the Netherlands first.';
  const [west, south, east, north] = view;
  if (!(3 <= west && west < east && east <= 8 && 50 <= south && south < north && north <= 54)) return 'Zoom in to a map view inside the Netherlands before reading public references.';
  return (east - west) * (north - south) > .25 ? 'Zoom in: this view is too large. Public reads are limited to 0.25 square degrees.' : null;
}

// Display bounds match the private field-reference contract. No reprojection,
// simplification, ring repair or eligibility/ownership judgement happens here.
function boundedGeometry(value: unknown): { geometry: FieldGeometry; positions: number } | null {
  const shape = object(value);
  if (!shape || !['Polygon', 'MultiPolygon'].includes(String(shape.type)) || 'crs' in shape) return null;
  const parts = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 20) return null;
  let positions = 0;
  const points: number[][] = [];
  for (const part of parts) {
    if (!Array.isArray(part) || part.length < 1 || part.length > 20) return null;
    for (const ring of part) {
      if (!Array.isArray(ring) || ring.length < 4 || ring.length > 500) return null;
      positions += ring.length;
      if (positions > 1000) return null;
      for (const point of ring) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(v => typeof v === 'number' && Number.isFinite(v)) || point[0] < 3 || point[0] > 8 || point[1] < 50 || point[1] > 54) return null;
        points.push(point);
      }
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) return null;
      if (new Set(ring.slice(0, -1).map(point => `${point[0]},${point[1]}`)).size !== ring.length - 1) return null;
    }
  }
  if (!points.length) return null;
  return { geometry: { type: shape.type as FieldGeometry['type'], coordinates: shape.coordinates as FieldGeometry['coordinates'] }, positions };
}

function parseRead(record: RecordItem, connection: Connection, scope: string, workspaceId: string, farmId: string): Read {
  if (record.workspace_id !== workspaceId || record.kind !== 'connection_reads' || record.data.farm_id !== farmId || record.data.connection_id !== connection.id) throw new Error('The returned public read does not belong to this farm workspace.');
  const result = object(record.data.result);
  if (!result || result.type !== 'FeatureCollection' || result.source_url !== SOURCE || !Array.isArray(result.features) || result.features.length > 50) throw new Error('The public parcel response no longer matches the bounded reference format. Nothing was selected.');
  const entries: Entry[] = [];
  let skipped = 0, positions = 0, propertyBytes = 0;
  result.features.forEach((value: unknown, index: number) => {
    const feature = object(value);
    const properties = object(feature?.properties);
    const checked = boundedGeometry(feature?.geometry);
    if (!feature || feature.type !== 'Feature' || !properties || !checked || positions + checked.positions > 5000) { skipped += 1; return; }
    let serialized: string;
    try { serialized = JSON.stringify(properties); } catch { skipped += 1; return; }
    if (serialized.length > 32000 || propertyBytes + serialized.length > 512000) { skipped += 1; return; }
    positions += checked.positions;
    propertyBytes += serialized.length;
    const externalId = typeof feature.id === 'number' && Number.isFinite(feature.id) ? String(feature.id) : text(feature.id);
    const crop = text(properties.gewas);
    const category = text(properties.category);
    const year = sourceYear(properties.jaar);
    const label = `${externalId || `Source feature ${index + 1}`} · ${category || 'Category unknown'} · ${crop || 'Description unknown'} · ${year ?? 'Year unknown'}`;
    entries.push({ id: `${record.id}:${index}`, label, geometry: checked.geometry, category, status: text(properties.status), originalProperties: properties,
      reference: { geometry: checked.geometry, external_id: externalId, crop, year,
        source: `PDOK BRP public comparison; ${SOURCE}; read ${record.id}; source year ${year ?? 'unknown'}. Not ownership or current-use evidence.` } });
  });
  return { scope, connection, id: record.id, readAt: text(record.data.read_at, 100) || 'Unknown retrieval time', entries, skipped, returned: result.features.length, truncated: result.truncated === true };
}

export function PublicParcelReference({ farm, viewport, onCandidates, onSelect, selectId = null, selectedSource }: PublicParcelReferenceProps) {
  const { session } = useSession();
  const permitted = !!session && (session.workspace.role === 'owner' || session.workspace.role === 'adviser') && farm.workspace_id === session.workspace.id && farm.data.country === 'NL';
  const scope = `${session?.user.id || ''}:${session?.workspace.id || ''}:${session?.workspace.role || ''}:${session?.workspace.permissions?.join(',') || ''}:${session?.workspace.farm_ids?.join(',') || ''}:${farm.id}:${farm.revision}:${farm.data.country}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const callbacks = useRef({ onCandidates, onSelect }); callbacks.current = { onCandidates, onSelect };
  const generation = useRef(0);
  const inFlight = useRef(false);
  const selecting = useRef(false);
  const createKey = useRef({ scope, key: crypto.randomUUID() });
  const handledSelection = useRef('');
  const [consent, setConsent] = useState(false);
  const consentRef = useRef(consent); consentRef.current = consent;
  const [reading, setReading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [checkingSelection, setCheckingSelection] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [connection, setConnection] = useState<{ scope: string; record: Connection } | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const visible = permitted && consent && read?.scope === scope ? read : null;
  const activeConnection = permitted && connection?.scope === scope ? connection.record : null;
  const problem = viewportProblem(viewport);

  useEffect(() => {
    generation.current += 1; consentRef.current = false; setConsent(false); setRead(null); setConnection(null); setError(''); setSelected(''); handledSelection.current = '';
    createKey.current = { scope, key: crypto.randomUUID() };
  }, [scope]);
  useEffect(() => { callbacks.current.onCandidates(visible?.entries.map(({ id, label, geometry }) => ({ id, label, geometry })) || []); }, [visible]);
  useEffect(() => () => { generation.current += 1; callbacks.current.onCandidates([]); }, []);

  function current(token: number, expectedScope: string) {
    return generation.current === token && scopeRef.current === expectedScope && consentRef.current;
  }
  function clearConsent() {
    generation.current += 1; consentRef.current = false; setConsent(false); setRead(null); setSelected(''); handledSelection.current = '';
  }
  function validateConnection(record: Connection, workspaceId: string) {
    if (record.workspace_id !== workspaceId || record.data.farm_id !== farm.id || record.data.capability_id !== CAPABILITY) throw new Error('This public connection is not available for the selected farm workspace.');
  }
  async function findReferences() {
    if (inFlight.current || selecting.current || disconnecting || !permitted || !consent || problem || !viewport || !session) return;
    inFlight.current = true;
    const token = ++generation.current, startedScope = scope, workspaceId = session.workspace.id;
    const bbox = [...viewport];
    setReading(true); setRead(null); setSelected(''); setError(''); handledSelection.current = '';
    try {
      const saved = await api.get<Page<Connection>>(`/connections?farm_id=${encodeURIComponent(farm.id)}&limit=200`);
      if (!current(token, startedScope)) return;
      let route = saved.items.find(item => item.data.capability_id === CAPABILITY && item.data.farm_id === farm.id);
      if (!route && saved.total > saved.items.length) throw new Error('There are more saved routes than this bounded lookup can inspect. Review Country connections before trying again.');
      if (!route) {
        route = await api.post<Connection>('/connections', { farm_id: farm.id, capability_id: CAPABILITY }, { idempotencyKey: createKey.current.key });
        if (!current(token, startedScope)) return;
      }
      validateConnection(route, workspaceId);
      setConnection({ scope: startedScope, record: route });
      if (route.data.status === 'not_connected') {
        // The user's consent and this button explicitly authorise a local public
        // read toggle, including reconnection. It is not a provider account grant.
        route = await api.post<Connection>(`/connections/${route.id}/activate`, { expected_revision: route.revision });
        if (!current(token, startedScope)) return;
        validateConnection(route, workspaceId);
        setConnection({ scope: startedScope, record: route });
      }
      if (route.data.status !== 'public_read_ready') throw new Error('Public read is not active for this route. Review Country connections before trying again.');
      const result = await api.post<RecordItem>(`/connections/${route.id}/read`, { bbox, limit: 50 });
      if (!current(token, startedScope)) return;
      const latest = await api.get<Connection>(`/connections/${route.id}`);
      if (!current(token, startedScope)) return;
      validateConnection(latest, workspaceId);
      if (latest.revision !== route.revision || latest.data.status !== 'public_read_ready') {
        clearConsent(); setConnection({ scope: startedScope, record: latest });
        setError('This connection changed or was disconnected during the read. The returned references were discarded. Check consent again only if you want to read or reconnect.'); return;
      }
      setConnection({ scope: startedScope, record: latest });
      setRead(parseRead(result, latest, startedScope, workspaceId, farm.id));
    } catch (failure) { if (current(token, startedScope)) setError(errorMessage(failure)); }
    finally { inFlight.current = false; setReading(false); }
  }

  async function compare(entry: Entry) {
    if (!visible || !session || inFlight.current || selecting.current || disconnecting || !consentRef.current) return;
    selecting.current = true; setCheckingSelection(true); setError('');
    handledSelection.current = entry.id;
    const token = generation.current, startedScope = scope, retained = visible;
    try {
      const latest = await api.get<Connection>(`/connections/${retained.connection.id}`);
      if (!current(token, startedScope)) return;
      validateConnection(latest, session.workspace.id);
      if (latest.revision !== retained.connection.revision || latest.data.status !== 'public_read_ready') {
        clearConsent(); setConnection({ scope: startedScope, record: latest }); setError('The public connection changed or was disconnected. Read this map view again only if you want to reconnect.'); return;
      }
      handledSelection.current = entry.id;
      callbacks.current.onSelect(entry.reference);
      setSelected(entry.id);
    } catch (failure) { if (current(token, startedScope)) setError(errorMessage(failure)); }
    finally { selecting.current = false; setCheckingSelection(false); }
  }

  useEffect(() => {
    if (!selectId) { handledSelection.current = ''; return; }
    if (handledSelection.current === selectId) return;
    const entry = visible?.entries.find(candidate => candidate.id === selectId);
    if (entry) void compare(entry);
  }, [selectId, visible, checkingSelection, reading, disconnecting]);

  async function disconnect() {
    if (!activeConnection || disconnecting || !session) return;
    const retained = activeConnection, startedScope = scope, workspaceId = session.workspace.id;
    clearConsent(); setDisconnecting(true); setError('');
    try {
      const latest = await api.get<Connection>(`/connections/${retained.id}`);
      if (scopeRef.current !== startedScope) return;
      validateConnection(latest, workspaceId);
      const stopped = await api.post<Connection>(`/connections/${retained.id}/disconnect`, { expected_revision: latest.revision });
      if (scopeRef.current === startedScope) setConnection({ scope: startedScope, record: stopped });
    } catch (failure) { if (scopeRef.current === startedScope) { setConnection(null); setError(`References were cleared, but the saved connection could not be confirmed disconnected. ${errorMessage(failure)}`); } }
    finally { setDisconnecting(false); }
  }

  if (!permitted) return null;
  return <section aria-label="Public Dutch parcel references" className="public-parcel-reference">
    <h4>Compare public Dutch parcel references</h4>
    <p>Load up to 50 public field outlines for this map view. Only the area you view is sent to PDOK, not your private farm records. These outlines do not confirm ownership, current crops or a submitted claim.</p>
    <label className="boundary-check"><input type="checkbox" checked={consent} disabled={disconnecting} onChange={event => { if (event.target.checked) { consentRef.current = true; setConsent(true); } else clearConsent(); }} />I want to read public parcel references for this map view.</label>
    {problem && <p className="muted">{problem}</p>}
    <div className="actions"><Button disabled={!consent || !!problem || reading || checkingSelection || disconnecting} loading={reading} onClick={() => void findReferences()}>Find reference parcels in this view</Button>{activeConnection && <Button variant="secondary" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? 'Disconnecting…' : 'Disconnect public references'}</Button>}</div>
    {reading && <p role="status">Reading this requested map view once. Panning does not make another public request. If you withdraw consent, an already requested read may finish but its response will be discarded.</p>}
    {error && <Notice kind="error">{error} You can use the same button to try again.</Notice>}
    {activeConnection?.data.status === 'not_connected' && <p className="muted">Public read is disconnected. Checking consent and pressing Find explicitly reconnects this local public-read route; no provider account is involved.</p>}
    {visible && <div><p>{visible.returned} public records found; {visible.entries.length} outlines can be compared. Check the source year before using one.</p><details><summary>When these references were loaded</summary><p>Loaded: {visible.readAt}. Saved read: <code>{visible.id}</code>.</p></details>
      {visible.skipped > 0 && <Notice kind="warning">{visible.skipped} records could not be shown because their outlines or details were missing, invalid or too large. They were not changed or repaired.</Notice>}
      {visible.truncated && <Notice kind="warning">More references may exist in this view. Zoom in and read again; no additional pages are fetched automatically.</Notice>}
      {!visible.returned && <p>No public references were returned for this view. This is not evidence that land is ineligible or unregistered.</p>}
      <p><a href={SOURCE} target="_blank" rel="noopener noreferrer">Official PDOK BRP source</a> · <a href="https://www.pdok.nl/ogc-apis/-/article/basisregistratie-gewaspercelen-brp-" target="_blank" rel="noopener noreferrer">Publisher documentation and terms</a></p>
      {visible.entries.map(entry => <article key={entry.id}><p><strong>{entry.label}</strong></p><p>Source year: {entry.reference.year ?? 'Unknown'} · category: {entry.category ?? 'Unknown'} · source status: {entry.status ?? 'Unknown'}. A source status such as Definitief does not mean a current farm claim or this app's filing was accepted.</p><Button variant="secondary" disabled={reading || checkingSelection || disconnecting} onClick={() => void compare(entry)}>Compare with this reference</Button>{selected === entry.id && (selectedSource === undefined || selectedSource === entry.reference.source) && <Notice kind="success">Selected for comparison only. Your actual field outline, crop, identifiers and ownership have not changed.</Notice>}<details><summary>Original source properties</summary><dl>{Object.entries(entry.originalProperties).map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{sourceValue(value)}</dd></div>)}</dl></details></article>)}
    </div>}
  </section>;
}

export default PublicParcelReference;
