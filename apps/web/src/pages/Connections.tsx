import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import type { Page, RecordItem } from '../types';
import { NebihDiary } from './NebihDiary';
import './connections.css';

type Workflow = 'annual' | 'cap' | 'inputs' | 'inspection' | 'sustainability';
type Source = { url?: string; title?: string };
type Documented = { id: string; title: string; mode?: string; setup_requirements?: string[]; supported_operations?: string[]; limitations?: string[]; sources?: Source[] };
type Capability = { id: string; country: string; workflow_id: Workflow; title: string; mode: 'public_read' | 'private_read' | 'portal_handoff'; live_read: boolean; live_write: boolean; automatic_filing: boolean; configuration_ready: boolean; official_url: string; setup_requirements: string[]; limitations: string[]; sources: Source[]; documented_connections: Documented[] };
type Connection = { farm_id: string; capability_id: string; title: string; status: string; credentials_present: boolean };
type HandoffData = { status: string; notice: string; official_url: string; downloads: Record<string, string> };
type PreviewData = { checksum: string; notice: string; expires_at: string; report_snapshot: { fields?: { label?: string; field?: string; value?: unknown; unit?: string; sources?: unknown[] }[] }; binding: { report_id: string; report_checksum: string; official_url: string } };
const workflowNames: Record<Workflow, string> = { annual: 'Annual records', cap: 'CAP / land declaration', inputs: 'Input use', inspection: 'Inspection evidence', sustainability: 'Sustainability' };
function display(value: unknown): string {
  if (value == null) return 'Not recorded';
  if (Array.isArray(value)) return value.map(display).join(', ');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key.replaceAll('_', ' ')}: ${display(item)}`).join('; ');
  return typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value);
}
function safeLink(url?: string) { try { const parsed = new URL(url || ''); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; } }
function Sources({ sources }: { sources: Source[] }) { return <ul className="connection-sources">{sources.map((source, index) => safeLink(source.url) ? <li key={index}><a href={safeLink(source.url)} target="_blank" rel="noopener noreferrer">{source.title || 'Official source'} (opens separately)</a></li> : null)}</ul>; }

function PublicParcelResults({ result }: { result: { features?: { id?: string | number; properties?: Record<string, unknown> }[]; source_url?: string } }) {
  const [showAll, setShowAll] = useState(false);
  const features = Array.isArray(result.features) ? result.features : [];
  return <section className="connection-parcel-results"><h3>Parcels returned by the source</h3>
    {features.length ? <ul>{(showAll ? features : features.slice(0, 5)).map((feature, index) => <li key={index}><strong>Source reference: {feature.id == null ? `not supplied (result ${index + 1})` : String(feature.id)}</strong><dl>{Object.entries(feature.properties ?? {}).map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{display(value)}</dd></div>)}</dl></li>)}</ul> : <p>No parcel details were returned for this map area.</p>}
    {features.length > 5 && <Button variant="secondary" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show fewer parcels' : `Show all ${features.length} parcels`}</Button>}
    {safeLink(result.source_url) && <p><a href={safeLink(result.source_url)} target="_blank" rel="noopener noreferrer">Read the original public source</a></p>}
  </section>;
}

export function Connections() {
  const { session } = useSession();
  const [query, setQuery] = useSearchParams();
  const farms = useRecords('farms');
  const farmId = query.get('farm_id') || farms.items[0]?.id || '';
  const farm = farms.items.find(item => item.id === farmId);
  const [workflow, setWorkflow] = useState<Workflow>('cap');
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [capabilityId, setCapabilityId] = useState('');
  const connections = useRecords<Connection>(`connections${farmId ? `?farm_id=${encodeURIComponent(farmId)}` : ''}`);
  const reports = useRecords(`reports${farmId ? `?farm_id=${encodeURIComponent(farmId)}` : ''}`);
  const [reportId, setReportId] = useState(query.get('report_id') || '');
  const [preview, setPreview] = useState<RecordItem<PreviewData> | null>(null);
  const [handoff, setHandoff] = useState<RecordItem<HandoffData> | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loadingCapabilities, setLoadingCapabilities] = useState(false);
  const [bbox, setBbox] = useState('');
  const [parcelRead, setParcelRead] = useState<RecordItem | null>(null);
  const generation = useRef(0);
  const canManage = session?.workspace.role === 'owner' || session?.workspace.role === 'adviser';
  const capability = capabilities.find(item => item.id === capabilityId);
  const connection = connections.items.find(item => item.data.capability_id === capabilityId && item.data.farm_id === farmId);
  const report = reports.items.find(item => item.id === reportId && item.data.farm_id === farmId && item.data.status === 'issued');

  useEffect(() => {
    let current = true;
    setCapabilities([]); setCapabilityId(''); setLoadingCapabilities(true);
    if (!farm) { setLoadingCapabilities(false); return; }
    api.get<Page<Capability>>(`/connections/capabilities?country=${encodeURIComponent(String(farm.data.country))}&workflow_id=${workflow}`)
      .then(result => { if (current) { setCapabilities(result.items); setCapabilityId(result.items.find(item => item.mode === 'portal_handoff')?.id || result.items[0]?.id || ''); } })
      .catch(failure => { if (current) setError(errorMessage(failure)); })
      .finally(() => { if (current) setLoadingCapabilities(false); });
    return () => { current = false; };
  }, [farm?.id, farm?.data.country, workflow, session?.workspace.id]);

  useEffect(() => { generation.current += 1; setPreview(null); setHandoff(null); setReviewed(false); setParcelRead(null); setError(''); setBusy(''); }, [farmId, workflow, capabilityId, reportId, session?.workspace.id]);

  useEffect(() => {
    let current = true;
    if (connection && capability?.mode === 'public_read') {
      api.get<Page>(`/connections/${connection.id}/reads?limit=1`).then(result => { if (current) setParcelRead(result.items[0] || null); }).catch(failure => { if (current) setError(errorMessage(failure)); });
    }
    return () => { current = false; };
  }, [connection?.id, capability?.mode, session?.workspace.id]);

  async function act(name: string, operation: () => Promise<void>) {
    const current = generation.current;
    setBusy(name); setError('');
    try { await operation(); } catch (failure) { if (current === generation.current) setError(errorMessage(failure)); }
    finally { if (current === generation.current) setBusy(''); }
  }
  async function setup() {
    if (!capability || !farmId) return;
    const current = generation.current;
    await api.post('/connections', { farm_id: farmId, capability_id: capability.id }, { idempotencyKey: crypto.randomUUID() });
    if (current === generation.current) await connections.reload();
  }
  async function preparePreview() {
    if (!connection || !report) return;
    const current = generation.current;
    const result = await api.post<RecordItem<PreviewData>>(`/connections/${connection.id}/preview`, { report_id: report.id, expected_report_revision: report.revision });
    if (current === generation.current) { setPreview(result); setHandoff(null); setReviewed(false); }
  }
  async function approveAndPrepare() {
    if (!connection || !preview || !reviewed) return;
    const current = generation.current;
    const approval = await api.post<RecordItem>(`/connections/${connection.id}/approve`, { preview_id: preview.id, expected_checksum: preview.data.checksum }, { idempotencyKey: `approval-${preview.id}` });
    if (current !== generation.current) return;
    const result = await api.post<RecordItem<HandoffData>>(`/connections/${connection.id}/handoff`, { approval_id: approval.id, expected_checksum: preview.data.checksum }, { idempotencyKey: `handoff-${approval.id}` });
    if (current === generation.current) setHandoff(result);
  }
  async function download(format: string, path: string) {
    const blob = await api.download(path);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `FunkyFarm-evidence.${format}`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="connections-page">
    <PageHeader title="Official websites and downloads" description="Choose the right website, read available records and prepare files to take with you." />
    <p className="connection-intro">Prepare files here, then send them through the official website. Nothing on this page sends an application automatically.</p>
    {error && <Notice kind="error">{error}</Notice>}
    {(farms.error || connections.error || reports.error) && <Notice kind="error">{farms.error || connections.error || reports.error}</Notice>}
    <section className="paper-section connection-picker" aria-labelledby="connection-choose"><h2 id="connection-choose">Choose your route</h2><div className="form-grid">
      <Field label="Farm"><select value={farmId} disabled={!!busy || farms.loading} onChange={event => { setQuery({ farm_id: event.target.value }); setReportId(''); }}><option value="">Choose a farm</option>{farms.items.map(item => <option key={item.id} value={item.id}>{display(item.data.name)} · {display(item.data.country)}</option>)}</select></Field>
      <Field label="Work to prepare"><select value={workflow} disabled={!!busy} onChange={event => setWorkflow(event.target.value as Workflow)}>{Object.entries(workflowNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="Available route"><select value={capabilityId} disabled={!!busy || loadingCapabilities || !capabilities.length} onChange={event => setCapabilityId(event.target.value)}><option value="">{loadingCapabilities ? 'Reading supported routes…' : 'Choose a route'}</option>{capabilities.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field>
    </div>{!farms.loading && !farms.items.length && <p><Link to="/app/farm/new">Add a farm</Link> before choosing a connection.</p>}{farm && !loadingCapabilities && !capabilities.length && <Notice>No reviewed connection route is published for this selection. You can still prepare an evidence report in Reports; no national integration is implied.</Notice>}</section>
    {capability && <section className="paper-section" aria-labelledby="connection-capability"><div className="connection-section-heading"><h2 id="connection-capability">{capability.title}</h2><span className="badge">{capability.mode === 'private_read' ? 'Private diary read' : capability.mode === 'public_read' ? 'Public parcel read' : 'Manual portal handoff'}</span></div>
      <p className="connection-state">{connection ? connection.data.status === 'public_read_ready' ? 'Public read activated · no filing permission' : connection.data.status === 'private_read_enabled' ? 'Private read enabled · authority access not verified' : 'Not connected to the authority' : 'Not set up'}{connection?.data.credentials_present && ' · encrypted credentials retained, unverified'}</p>
      <h3>What you need</h3><ul>{capability.setup_requirements.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <h3>Limits of this route</h3><ul>{capability.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul><Sources sources={capability.sources} />
      {safeLink(capability.official_url) && <p><a href={safeLink(capability.official_url)} target="_blank" rel="noopener noreferrer">Open the official starting route separately</a></p>}
      {!connection && <Button disabled={!canManage || !!busy || connections.loading} onClick={() => void act('setup', setup)}>{busy === 'setup' ? 'Saving route…' : 'Save this route for my farm'}</Button>}
      {connection && <><Button variant="secondary" disabled={!canManage || !!busy} onClick={() => void act('disconnect', async () => { await api.post(`/connections/${connection.id}/disconnect`, { expected_revision: connection.revision }); setPreview(null); setHandoff(null); await connections.reload(); })}>Disconnect this route</Button><p className="muted">This does not revoke credentials at the authority. Encrypted earlier revisions may remain in the workspace audit history; contact the operator about retention.</p></>}
      {!canManage && <p className="muted">An owner or adviser must configure routes and approve handoffs.</p>}
      <details className="connection-inventory"><summary>Other documented services</summary><p>These services are documented by the authority but are not connected here. Check the setup and access requirements before using them.</p>{capability.documented_connections.length ? capability.documented_connections.map(item => <article key={item.id}><h3>{item.title}</h3><p className="muted">Not set up in this workspace · {item.mode?.replaceAll('_', ' ')}</p><ul>{item.setup_requirements?.map((need, index) => <li key={index}>{need}</li>)}{item.limitations?.map((limit, index) => <li key={`limit-${index}`}>{limit}</li>)}</ul><Sources sources={item.sources || []} /></article>) : <p>No other connected service or accepted import format has been established for this route.</p>}</details>
    </section>}
    {capability?.mode === 'private_read' && connection && <NebihDiary key={`${session?.user.id}:${session?.workspace.id}:${connection.id}`} connection={connection} configurationReady={capability.configuration_ready} reload={connections.reload} />}
    {capability?.mode === 'portal_handoff' && connection && <section className="paper-section" aria-labelledby="connection-handoff"><h2 id="connection-handoff">Prepare files for the official website</h2><p>Prepare the report and its records, then follow the authority's current instructions for sending them.</p>
      <Field label="Issued report"><select value={reportId} disabled={!!busy || reports.loading} onChange={event => setReportId(event.target.value)}><option value="">Choose an approved report</option>{reports.items.filter(item => item.data.farm_id === farmId && item.data.status === 'issued').map(item => <option key={item.id} value={item.id}>{display(item.data.pack_id)} · {display(item.data.reporting_year)} · {item.id.slice(0, 8)}</option>)}</select></Field>
      {!report && <p><Link to="/app/reports">Prepare and approve a report</Link> first. Its workflow must match this route.</p>}
      <Button disabled={!report || !canManage || !!busy} onClick={() => void act('preview', preparePreview)}>{busy === 'preview' ? 'Checking retained evidence…' : 'Check the download'}</Button>
      {preview && <div className="connection-review"><h3>Check the file before preparing it</h3><p>{preview.data.notice}</p><p><Link to={`/app/reports/${preview.data.binding.report_id}`}>Review the complete report and its source references</Link></p><dl className="evidence-list">{preview.data.report_snapshot.fields?.map((field, index) => <div key={index}><dt>{field.label || field.field}</dt><dd>{display(field.value)} {field.unit}<small className="muted"> · {field.sources?.length || 0} retained source reference(s)</small></dd></div>)}</dl><details className="connection-version-details"><summary>File versions</summary><p className="connection-checksum">Report SHA-256: {preview.data.binding.report_checksum}<br />Handoff SHA-256: {preview.data.checksum}</p></details><p className="muted">Expires {new Date(preview.data.expires_at).toLocaleString()}. If the records, destination or access change, prepare a new preview.</p>
        <label className="check-row"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} disabled={!!busy || !!handoff} />I reviewed this report, the destination and the limits. I approve preparing this manual handoff; nothing will be sent.</label><Button disabled={!reviewed || !canManage || !!busy || !!handoff} onClick={event => { if (event.nativeEvent.isTrusted) void act('approve', approveAndPrepare); }}>{busy === 'approve' ? 'Recording this approval…' : 'Approve and prepare my download'}</Button>
      </div>}
      {handoff && <div className="connection-result"><Notice kind="success">Manual handoff prepared. Nothing was sent to the authority.</Notice><p>{handoff.data.notice}</p><div className="actions">{Object.entries(handoff.data.downloads).map(([format, path]) => <Button key={format} disabled={!!busy} onClick={() => void act(`download-${format}`, () => download(format, path))}>Download evidence {format.toUpperCase()}</Button>)}</div>{safeLink(handoff.data.official_url) && <p><a href={safeLink(handoff.data.official_url)} target="_blank" rel="noopener noreferrer">Continue in the official portal (separate sign-in)</a></p>}<p>After completing the official flow, retain its actual receipt. Record it in <Link to={`/app/reports/${reportId}`}>the report’s delivery references</Link> without claiming automated acceptance.</p></div>}
    </section>}
    {capability?.mode === 'public_read' && connection && <section className="paper-section" aria-labelledby="connection-public"><h2 id="connection-public">Find public parcel records</h2><p>Only the map extent is sent to PDOK. Nothing in this action imports farm facts or sends an application.</p>
      {connection.data.status !== 'public_read_ready' ? <Button disabled={!canManage || !!busy} onClick={() => void act('activate', async () => { await api.post(`/connections/${connection.id}/activate`, { expected_revision: connection.revision }); await connections.reload(); })}>Activate this public read</Button> : <form onSubmit={event => { event.preventDefault(); void act('read', async () => { const current = generation.current; const result = await api.post<RecordItem>(`/connections/${connection.id}/read`, { bbox: bbox.split(',').map(value => Number(value.trim())), limit: 50 }); if (current === generation.current) setParcelRead(result); }); }}><Field label="Map extent: west, south, east, north" hint="Longitude/latitude in the Netherlands; at most 0.25 square degrees. Example: 5.1,52.0,5.11,52.01"><input value={bbox} onChange={event => setBbox(event.target.value)} required placeholder="5.1,52.0,5.11,52.01" disabled={!!busy} /></Field><Button type="submit" disabled={!canManage || !!busy || !bbox}>{busy === 'read' ? 'Reading official public data…' : 'Read up to 50 public parcels'}</Button></form>}
      {parcelRead && <div className="connection-result"><Notice>{display(parcelRead.data.result?.notice)}</Notice><p>{display(parcelRead.data.result?.number_returned)} source parcels saved for comparison. {parcelRead.data.result?.truncated ? 'More may exist; narrow the map extent.' : ''}</p><PublicParcelResults key={`${parcelRead.id}:${parcelRead.revision}`} result={parcelRead.data.result || {}}/><p>Check the year, crop and right to use the land against your own records. These results have not changed your farm’s saved fields.</p></div>}
    </section>}
  </div>;
}

export default Connections;
