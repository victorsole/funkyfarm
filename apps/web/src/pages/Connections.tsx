import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import type { Page, RecordItem } from '../types';
import { NebihDiary } from './NebihDiary';
import { ConnectionFields } from './ConnectionFields';
import { ConnectionPaperwork } from './ConnectionPaperwork';
import './connections.css';

type Workflow = 'annual' | 'cap' | 'inputs' | 'inspection' | 'sustainability';
type Task = 'fields' | 'paperwork' | 'history';
type Source = { url?: string; title?: string };
type Documented = { id: string; title: string; setup_requirements?: string[]; limitations?: string[]; sources?: Source[] };
type Capability = { id: string; country: string; workflow_id: Workflow; title: string; mode: 'public_read' | 'private_read' | 'portal_handoff'; live_read: boolean; configuration_ready: boolean; official_url: string; setup_requirements: string[]; limitations: string[]; sources: Source[]; documented_connections: Documented[] };
type Connection = RecordItem<{ farm_id: string; capability_id: string; title: string; status: string; credentials_present: boolean }>;
const workflows: Record<Workflow, string> = { annual: 'Annual records', cap: 'CAP and land declaration', inputs: 'Input use', inspection: 'Inspection records', sustainability: 'Environmental commitments' };
const tasks: { id: Task; title: string; text: string }[] = [
  { id: 'fields', title: 'Bring in records', text: 'Find public field outlines or read an available farm diary.' },
  { id: 'paperwork', title: 'Prepare paperwork', text: 'Check values and take the right files to the official website.' },
  { id: 'history', title: 'Continue where I left off', text: 'Reopen saved checks, downloads and earlier searches.' },
];
function safeLink(url?: string) { try { const parsed = new URL(url || ''); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; } }
function Sources({ sources }: { sources: Source[] }) { return <ul className="connection-sources">{sources.map((source, index) => safeLink(source.url) ? <li key={index}><a href={safeLink(source.url)} target="_blank" rel="noopener noreferrer">{source.title || 'Official source'}</a></li> : null)}</ul>; }

export function Connections() {
  const { session } = useSession();
  const [query, setQuery] = useSearchParams();
  const farms = useRecords('farms');
  const farmId = query.get('farm_id') || farms.items[0]?.id || '';
  const farm = farms.items.find(item => item.id === farmId);
  const connections = useRecords<{ farm_id: string; capability_id: string; title: string; status: string; credentials_present: boolean }>(`connections${farmId ? `?farm_id=${encodeURIComponent(farmId)}` : ''}`);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sourceDetails, setSourceDetails] = useState(false);
  const [services, setServices] = useState(false);
  const [reportWorkflow, setReportWorkflow] = useState<Workflow | null>(null);
  const requestedConnection = connections.items.find(item => item.id === query.get('connection_id'));
  const requestedCapability = capabilities.find(item => item.id === requestedConnection?.data.capability_id);
  const rawTask = query.get('task');
  const task: Task = rawTask === 'fields' || rawTask === 'paperwork' || rawTask === 'history' ? rawTask : requestedCapability && requestedCapability.mode !== 'portal_handoff' ? 'fields' : 'paperwork';
  const rawWorkflow = query.get('workflow') || requestedCapability?.workflow_id || reportWorkflow || 'cap';
  const workflow: Workflow = Object.hasOwn(workflows, rawWorkflow) ? rawWorkflow as Workflow : 'cap';
  const routes = capabilities.filter(item => task === 'fields' ? item.mode !== 'portal_handoff' : task === 'history' ? true : item.mode === 'portal_handoff' && item.workflow_id === workflow);
  const selectedId = requestedCapability?.id || query.get('capability_id');
  const capability = routes.find(item => item.id === selectedId) || routes[0];
  const connection = connections.items.find(item => item.data.capability_id === capability?.id && item.data.farm_id === farmId);
  const scope = `${session?.user.id}:${session?.workspace.id}:${farmId}:${capability?.id}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const canManage = !!session && (session.workspace.role === 'owner' || session.workspace.role === 'adviser' && session.workspace.permissions?.includes('review') === true);

  useEffect(() => {
    let current = true; setCapabilities([]); setError(''); setLoading(!!farm); setSourceDetails(false); setServices(false);
    if (farm) api.get<Page<Capability>>(`/connections/capabilities?country=${encodeURIComponent(String(farm.data.country))}`).then(result => { if (current) setCapabilities(result.items); }).catch(failure => { if (current) setError(errorMessage(failure)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [farm?.id, farm?.data.country, session?.workspace.id]);
  useEffect(() => {
    let current = true; setReportWorkflow(null);
    const reportId = query.get('report_id');
    if (reportId && farm) api.get<RecordItem>(`/reports/${encodeURIComponent(reportId)}`).then(record => {
      const selected = record.data.snapshot?.pack?.workflow_id;
      if (current && record.data.farm_id === farm.id && typeof selected === 'string' && Object.hasOwn(workflows, selected)) setReportWorkflow(selected as Workflow);
    }).catch(failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [query.get('report_id'), farm?.id, session?.workspace.id]);

  function chooseTask(next: Task) { setQuery({ farm_id: farmId, task: next }); setError(''); setSourceDetails(false); setServices(false); }
  async function ensureConnection(): Promise<Connection> {
    if (!farm || !capability || !canManage || connections.loading || connections.error) throw new Error('Choose a farm and wait for its routes to finish loading.');
    if (connection) return connection;
    const captured = scope;
    const created = await api.post<Connection>('/connections', { farm_id: farmId, capability_id: capability.id }, { idempotencyKey: `route-${farmId}-${capability.id}` });
    if (scopeRef.current !== captured) throw new Error('The selected farm or route changed. Reopen its saved route before continuing.');
    await connections.reload();
    return created;
  }
  async function saveRoute() {
    setBusy(true); setError(''); const captured = scope;
    try { await ensureConnection(); } catch (failure) { if (scopeRef.current === captured) setError(errorMessage(failure)); }
    finally { if (scopeRef.current === captured) setBusy(false); }
  }
  async function disconnect() {
    if (!connection) return; setBusy(true); setError(''); const captured = scope;
    try { await api.post(`/connections/${connection.id}/disconnect`, { expected_revision: connection.revision }); if (scopeRef.current === captured) await connections.reload(); }
    catch (failure) { if (scopeRef.current === captured) setError(errorMessage(failure)); }
    finally { if (scopeRef.current === captured) setBusy(false); }
  }

  return <div className="connections-page">
    <PageHeader title="Official websites and downloads" description="Bring records in, prepare paperwork and keep track of what comes next."/>
    {(error || farms.error || connections.error) && <Notice kind="error">{error || farms.error || connections.error}</Notice>}
    <section className="paper-section connection-picker" aria-labelledby="connection-choose"><h2 id="connection-choose">What would you like to do?</h2>
      <Field label="Farm"><select value={farmId} disabled={busy || farms.loading} onChange={event => setQuery({ farm_id: event.target.value, task })}><option value="">Choose a farm</option>{farms.items.map(item => <option key={item.id} value={item.id}>{String(item.data.name)} · {String(item.data.country)}</option>)}</select></Field>
      <div className="connection-task-list">{tasks.map(item => <button type="button" key={item.id} aria-label={item.title} aria-pressed={task === item.id} className={`connection-task${task === item.id ? ' is-selected' : ''}`} disabled={busy || !farm} onClick={() => chooseTask(item.id)}><strong>{item.title}</strong><span>{item.text}</span></button>)}</div>
      {!farms.loading && !farms.items.length && <p><Link to="/app/fields">Add a farm</Link> to see the available routes.</p>}
    </section>
    {farm && <>
      <section className="connection-route-choice" aria-label="Official route">
        {task === 'paperwork' && <Field label="Work to prepare"><select value={workflow} disabled={busy || loading} onChange={event => setQuery({ farm_id: farmId, task, workflow: event.target.value })}>{Object.entries(workflows).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>}
        {routes.length > 1 && <Field label="Available route"><select value={capability?.id || ''} disabled={busy || loading} onChange={event => setQuery({ farm_id: farmId, task, capability_id: event.target.value, workflow: capabilities.find(item => item.id === event.target.value)?.workflow_id || workflow })}>{routes.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></Field>}
      </section>
      {loading && <p role="status">Reading available routes…</p>}
      {!loading && !routes.length && <section className="paper-section"><h2>No direct record connection for this farm yet</h2><p>You can still <Link to={`/app/documents?farm_id=${farmId}`}>upload records</Link> or <Link to={`/app/fields/${farmId}`}>bring in field outlines from a file</Link>. To prepare files for the official website, choose Prepare paperwork.</p></section>}
      {query.get('connection_id') && !connections.loading && !requestedConnection && <Notice kind="warning">That saved connection is not available for this farm. Choose a route below; no other farm's records have been opened.</Notice>}
      {capability && <>
        <section className="paper-section connection-route-summary"><div className="connection-section-heading"><h2>{capability.title}</h2><span className="badge">{capability.mode === 'public_read' ? 'Public records' : capability.mode === 'private_read' ? 'Farm diary read' : 'Prepare here, send on the official website'}</span></div>
          <p>{capability.mode === 'portal_handoff' ? 'Download reviewed records here, then complete the official website’s own checks and sign-in.' : capability.mode === 'public_read' ? 'Read public outlines without sharing your farm records or government sign-in details.' : capability.configuration_ready ? 'The diary reader is configured. Your farm owner still needs to provide the correct diary token.' : 'This diary reader needs approved operator access before it can connect. Do not enter a government password.'}</p>
          {safeLink(capability.official_url) && <p><a href={safeLink(capability.official_url)} target="_blank" rel="noopener noreferrer">Open the official website</a></p>}
          <div className="actions"><Button variant="ghost" onClick={() => setSourceDetails(value => !value)} aria-expanded={sourceDetails}>{sourceDetails ? 'Hide setup and sources' : 'Setup and official sources'}</Button>{capability.documented_connections.length > 0 && <Button variant="ghost" onClick={() => setServices(value => !value)} aria-expanded={services}>{services ? 'Hide other services' : 'Other documented services'}</Button>}</div>
          {sourceDetails && <div className="connection-route-details"><h3>What you need</h3><ul>{capability.setup_requirements.map((item, index) => <li key={index}>{item}</li>)}</ul><h3>What this route does not do</h3><ul>{capability.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul><Sources sources={capability.sources}/>
            {connection && <><Button variant="secondary" disabled={!canManage || busy} onClick={() => void disconnect()}>Disconnect this route</Button><p className="muted">Saved history stays available. To revoke access at the authority, use its own account settings. Older encrypted token revisions may remain under the workspace retention policy.</p></>}
          </div>}
          {services && <div className="connection-inventory"><p>These are documented services, not connected services in Funkyfarm.</p>{capability.documented_connections.map(item => <article key={item.id}><h3>{item.title}</h3><ul>{item.setup_requirements?.map((value, index) => <li key={index}>{value}</li>)}{item.limitations?.map((value, index) => <li key={`limit-${index}`}>{value}</li>)}</ul><Sources sources={item.sources || []}/></article>)}</div>}
        </section>
        {capability.mode === 'public_read' && <ConnectionFields key={scope} farm={farm} connection={connection} ensureConnection={ensureConnection} canManage={canManage && !connections.loading && !connections.error}/>}
        {capability.mode === 'private_read' && (connection ? <NebihDiary key={scope} connection={connection} configurationReady={capability.configuration_ready} reload={connections.reload}/> : <section className="paper-section"><h2>Read an available farm diary</h2><p>Save this route to see its setup steps. This does not make an authority request.</p><Button disabled={!canManage || busy || connections.loading} loading={busy} onClick={() => void saveRoute()}>Save this route for my farm</Button></section>)}
        {capability.mode === 'portal_handoff' && <ConnectionPaperwork key={scope} farm={farm} connection={connection} ensureConnection={ensureConnection} workflow={capability.workflow_id} canManage={canManage && !connections.loading && !connections.error} historyOnly={task === 'history'}/>}
      </>}
    </>}
  </div>;
}

export default Connections;
