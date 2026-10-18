import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import type { Page, RecordItem } from '../types';
import './assistantHelp.css';

type Configuration = { available: boolean; resource?: string; issuer?: string; message: string; local_development?: boolean; provider_account_verified: boolean };
type PendingConsent = { request_id: string; client_name: string; client_id: string; redirect_uri: string; redirect_hostname: string; requested_scopes: string[]; resource: string; expires_at: string; workspace: { id: string }; farms: { id: string; name: string }[]; farm_count: number; farm_limit: number; notice: string };
type Connection = RecordItem<{ client_name: string; client_id: string; farm_ids: string[]; permissions: string[]; scope: string; expires_at: string; revoked_at: string | null; last_issued_at: string | null }>;

const references = {
  chatgpt: 'https://developers.openai.com/plugins/build/auth',
  claude: 'https://claude.com/docs/connectors/building/authentication',
  mcp: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization',
};

export function AssistantConnect() {
  const { session } = useSession();
  return <ConnectionPage key={session ? `${session.user.id}/${session.workspace.id}` : 'signed-out'} />;
}

function ConnectionPage() {
  const { session } = useSession();
  const [params] = useSearchParams();
  const requestId = params.get('request');
  const owner = session?.workspace.role === 'owner';
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [pending, setPending] = useState<PendingConsent | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionOffset, setConnectionOffset] = useState(0);
  const [connectionTotal, setConnectionTotal] = useState(0);
  const [selectedFarms, setSelectedFarms] = useState<string[]>([]);
  const [propose, setPropose] = useState(false);
  const [refresh, setRefresh] = useState(false);
  const [disclosure, setDisclosure] = useState(false);
  const [provider, setProvider] = useState<'chatgpt' | 'claude'>('chatgpt');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [chatAvailable, setChatAvailable] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');

  // Copy public entry points only: never the current URL, consent request or credentials.
  const siteAddress = `${window.location.origin}/app`;
  let connectionAddress = '';
  try {
    const address = new URL(configuration?.resource || '');
    if (configuration?.available && ['https:', 'http:'].includes(address.protocol) && !address.username && !address.password && !address.search && !address.hash) connectionAddress = address.href;
  } catch { /* An unavailable public connection still permits a browser instruction. */ }
  const instruction = `Open ${siteAddress} in your browser and help me work through my farm paperwork, one question at a time. Ask me what I need help with and which farm to use. If your browser supports this website’s tools (WebMCP), use those tools only after I choose the farms and permissions.${connectionAddress ? ` If browser tools are unavailable and your assistant supports remote MCP connections, the connection address is ${connectionAddress}. Start the sign-in and farm-permission request there; I will approve it myself on the website.` : ' If website tools are unavailable, tell me what to open and check myself.'} Do not ask me to paste passwords, access keys or connection codes into this conversation. Do not confirm records, approve reports, send or file anything for me. Keep suggestions separate from saved records and ask me to review each proposed change on the website.`;

  async function reloadConnections(offset = connectionOffset) {
    const page = await api.get<Page<Connection>>(`/assistant/oauth/connections?limit=20&offset=${offset}`);
    setConnections(page.items);
    setConnectionOffset(page.offset); setConnectionTotal(page.total);
  }

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setPending(null); setSelectedFarms([]); setPropose(false); setRefresh(false); setDisclosure(false);
    setChatAvailable(false);
    void api.get<{ available: boolean }>('/assistant/chat/status').then(value => { if (active) setChatAvailable(value.available); }).catch(() => { /* Optional alternative, not a connection requirement. */ });
    void (async () => {
      try {
        const config = await api.get<Configuration>('/assistant/oauth/config');
        if (active) setConfiguration(config);
        if (!owner) return;
        const page = await api.get<Page<Connection>>('/assistant/oauth/connections?limit=20&offset=0');
        if (active) { setConnections(page.items); setConnectionOffset(0); setConnectionTotal(page.total); }
        if (requestId) {
          if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error('This connection request is not valid. Start again from your assistant.');
          const consent = await api.get<PendingConsent>(`/assistant/oauth/requests/${encodeURIComponent(requestId)}`);
          if (active) setPending(consent);
        }
      } catch (failure) { if (active) setError(failure); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [requestId, owner]);

  async function consent(decision: 'allow' | 'deny') {
    if (!pending) return;
    setBusy(true); setError(null);
    try {
      const result = await api.post<{ redirect_url: string }>(`/assistant/oauth/requests/${pending.request_id}/consent`, {
        decision, farm_ids: decision === 'allow' ? selectedFarms : [],
        allow_propose: decision === 'allow' && propose, allow_refresh: decision === 'allow' && refresh,
      });
      // A code is passed directly to the registered callback, never to a draft,
      // application route, browser storage or the conversation.
      const expected = new URL(pending.redirect_uri);
      const destination = new URL(result.redirect_url);
      if (destination.origin !== expected.origin || destination.pathname !== expected.pathname || destination.hash || destination.username || destination.password) throw new Error('The callback changed unexpectedly. The connection was not opened; review access below before retrying.');
      window.location.assign(destination.href);
    } catch (failure) { setError(failure); setBusy(false); }
  }

  async function disconnect(connection: Connection) {
    setBusy(true); setError(null); setMessage('');
    try {
      await api.post(`/assistant/oauth/connections/${connection.id}/revoke`, { expected_revision: connection.revision });
      await reloadConnections(0);
      setMessage('Access was revoked. This assistant can no longer read these farms or prepare new suggestions through this connection.');
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  async function copyAddress() {
    if (!connectionAddress) return;
    setError(null); setMessage('');
    try { await navigator.clipboard.writeText(connectionAddress); setMessage('Connection address copied. Use it only in your assistant’s connection settings.'); }
    catch { setMessage('Select and copy the server address shown below. Your browser did not allow clipboard access.'); }
  }

  async function copyInstruction() {
    try { await navigator.clipboard.writeText(instruction); setCopyMessage('Instruction copied. Paste it into your assistant, then let it explain what it can do.'); }
    catch { setCopyMessage('Your browser could not copy the instruction. Open “Read or copy the instruction yourself” below, then select and copy the text.'); }
  }

  return <>
    <PageHeader title={pending ? 'Choose what your assistant can access' : 'Use your own assistant'} description={pending ? 'This browser request needs your decision. Choose the farms and permissions before continuing.' : 'Ask the assistant you already use to open this website and help you, one step at a time.'} />
    {loading && <Notice>Opening assistant connection settings…</Notice>}
    {error && <Notice kind="error">{errorMessage(error)}{error instanceof ApiError && error.status === 409 && <p>The saved connection changed. Reload it before trying again.</p>}{requestId && <p>To restart an expired connection, return to your assistant and choose Connect again in this browser.</p>}<Button variant="secondary" onClick={() => window.location.reload()}>Reload this page</Button></Notice>}
    {message && <Notice kind="success">{message}</Notice>}
    {!owner && <Notice>Only the workspace owner can grant an assistant access. Ask the owner to connect the farms they want to share.</Notice>}

    {pending && owner && <section className="card"><h2>{pending.client_name} is requesting access</h2>
      <p>The request will return to <strong>{pending.redirect_hostname}</strong>.</p>
      <p className="muted">The application name was supplied during client registration. It does not prove a verified provider account or an endorsed connector.</p>
      <p>You are authorizing access in <strong>{session?.workspace.name}</strong>. The connection request expires {new Date(pending.expires_at).toLocaleTimeString()}.</p>
      <form className="stack" onSubmit={event => { event.preventDefault(); void consent('allow'); }}>
        <fieldset disabled={busy}><legend>Which farms may this assistant access?</legend>
          {pending.farms.map(farm => <label className="field" key={farm.id}><span><input type="checkbox" checked={selectedFarms.includes(farm.id)} onChange={event => setSelectedFarms(current => event.target.checked ? [...current, farm.id] : current.filter(id => id !== farm.id))} /> {farm.name}</span></label>)}
          {!pending.farms.length && <p>Add a farm before connecting an assistant. <Link to="/app/fields">Open My fields</Link>.</p>}
          {pending.farm_count > pending.farm_limit && <p className="muted">The first {pending.farm_limit} farms are shown. A connection can include at most {pending.farm_limit} explicitly selected farms.</p>}
        </fieldset>
        <fieldset disabled={busy}><legend>What may it do?</legend>
          <p><strong>Read the selected farms:</strong> find bounded record summaries, list tasks, check missing evidence and find an already approved report’s private download route.</p>
          {pending.requested_scopes.includes('farm:propose') && <label className="field"><span><input type="checkbox" checked={propose} onChange={event => setPropose(event.target.checked)} /> Also stage facts, work, purchases, sales or report previews for my review.</span></label>}
          {pending.requested_scopes.includes('offline_access') && <label className="field"><span><input type="checkbox" checked={refresh} onChange={event => setRefresh(event.target.checked)} /> Keep this connection available for up to seven days.</span><small className="muted">Otherwise access lasts up to 15 minutes. You can revoke the connection at any time.</small></label>}
          <p>Assistant access cannot confirm evidence, approve or issue reports, send documents, file with authorities, change account settings or grant another assistant access.</p>
        </fieldset>
        <label><input type="checkbox" required disabled={busy} checked={disclosure} onChange={event => setDisclosure(event.target.checked)} /> I want the selected farm information returned to this assistant when it uses these tools. I have checked the callback domain and permissions.</label>
        <details><summary>Exact connection details</summary><dl><div><dt>Client ID</dt><dd style={{ overflowWrap: 'anywhere' }}>{pending.client_id}</dd></div><div><dt>Registered callback</dt><dd style={{ overflowWrap: 'anywhere' }}>{pending.redirect_uri}</dd></div><div><dt>Protected farm service</dt><dd style={{ overflowWrap: 'anywhere' }}>{pending.resource}</dd></div></dl><p>{pending.notice}</p></details>
        <div className="actions"><Button type="submit" loading={busy} disabled={!selectedFarms.length || !disclosure}>Allow selected farm access</Button><Button variant="secondary" disabled={busy} onClick={() => void consent('deny')}>Decline connection</Button></div>
      </form>
    </section>}

    {!pending && <section className="card assistant-help-start"><p className="eyebrow">Start with a conversation</p><h2>Give your assistant one instruction</h2>
      <p>Copy the instruction, paste it into ChatGPT, Claude or another assistant you use, and ask it to open this website. You do not need to write a settings file.</p>
      <div className="actions"><Button disabled={loading} onClick={() => void copyInstruction()}>Copy instruction</Button>{chatAvailable && <Link to="/app/help#in-app-help">Ask inside Funkyfarm instead</Link>}</div>
      {copyMessage && <p role="status" className="assistant-copy-status">{copyMessage}</p>}
      <p className="muted">Not every assistant or browser can use website tools or connect to farm records. Copying this instruction does not link accounts or grant access. Your assistant may need to guide you through the website instead.</p>
      <details className="assistant-help-details"><summary>Read or copy the instruction yourself</summary><Field label="Instruction for your assistant"><textarea className="assistant-instruction" readOnly value={instruction} onFocus={event => event.target.select()} /></Field></details>
      <div className="assistant-help-permission"><h3>You choose what it can see</h3><p>If the assistant requests a connection, check the website address and choose the farms and permissions yourself. Information you share goes to that assistant’s service. Suggestions still need your review here; nothing is sent or filed for you.</p></div>
      <details className="assistant-help-details"><summary>Connection setup and compatibility</summary>
      <p>This website offers browser tools through WebMCP and a remote MCP connection using OAuth. A compatible assistant must start the connection; opening this page alone does not connect your account.</p>
      {!configuration ? <p>Connection settings could not be loaded. Reload this page to try again, or use the browser instruction above.</p> : !configuration.available ? <Notice kind="warning">The remote connection is not available on this installation. You can still ask your assistant to guide you through the website.</Notice> : <>
        {configuration.local_development && <Notice kind="warning">This is a local development address. A cloud-hosted ChatGPT or Claude connector cannot reach this computer through it. Public HTTPS hosting and a real provider-account connection remain unverified.</Notice>}
        <Field label="MCP server address"><input readOnly value={connectionAddress} onFocus={event => event.target.select()} /></Field><Button variant="secondary" disabled={!connectionAddress} onClick={() => void copyAddress()}>Copy server address</Button>
        <Field label="Your assistant"><select value={provider} onChange={event => setProvider(event.target.value as 'chatgpt' | 'claude')}><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option></select></Field>
        <p>{provider === 'claude' ? 'In Claude, add a custom remote connector, paste this server address, and choose OAuth with automatic client registration. Select Connect to begin the browser consent flow.' : 'In ChatGPT, add a custom MCP connector using this server address and OAuth. Use automatic client registration when asked, then start the connection.'}</p>
        <p>Provider settings and access depend on your account and organization. This application does not verify your subscription, use your provider’s session, or ask for provider API keys.</p>
        <div className="actions"><a className="button button-secondary" href={provider === 'claude' ? 'https://claude.ai/' : 'https://chatgpt.com/'} target="_blank" rel="noreferrer">Open {provider === 'claude' ? 'Claude' : 'ChatGPT'}</a><a href={references[provider]} target="_blank" rel="noreferrer">Official OAuth connector guidance</a></div>
      </>}
      <p className="muted">Technical references: <a href={references.chatgpt} target="_blank" rel="noreferrer">OpenAI authentication guidance</a>, <a href={references.claude} target="_blank" rel="noreferrer">Claude authentication guidance</a>, <a href={references.mcp} target="_blank" rel="noreferrer">MCP authorization specification</a>.</p>
      </details>
    </section>}

    {owner && <section className="card"><h2>Farm access you granted</h2><p>Revoking access stops future use of this connection. Information already returned to an assistant is governed by that provider’s retention settings.</p>
      {!loading && !connections.length && <p className="muted">No assistant connections are saved in this workspace.</p>}
      {connections.map(connection => {
        const active = !connection.data.revoked_at && new Date(connection.data.expires_at).getTime() > Date.now();
        return <article className="panel" key={connection.id}><h3>{connection.data.client_name}</h3><p><span className="badge">{connection.data.revoked_at ? 'Revoked' : !active ? 'Expired' : connection.data.last_issued_at ? 'Access issued' : 'Waiting for the assistant to finish connecting'}</span> · {connection.data.permissions.includes('propose') ? 'Read and prepare suggestions' : 'Read only'}</p><p>{connection.data.farm_ids.length} explicitly selected {connection.data.farm_ids.length === 1 ? 'farm' : 'farms'} · expires {new Date(connection.data.expires_at).toLocaleString()}</p>
          {connection.data.last_issued_at && <p className="muted">Access last issued {new Date(connection.data.last_issued_at).toLocaleString()}. This does not verify a ChatGPT or Claude account, or prove that it used the connection.</p>}
          <details><summary>Selected farms and access details</summary><ul>{connection.data.farm_ids.map((farmId, index) => <li key={farmId}><Link to={`/app/fields/${encodeURIComponent(farmId)}`}>Open selected farm {index + 1}</Link> <code>{farmId}</code></li>)}</ul><p>{connection.data.scope.split(' ').includes('offline_access') ? 'Rotating refresh access was allowed until the expiry shown above.' : 'No refresh access was granted.'}</p><p>Registered client: <code style={{ overflowWrap: 'anywhere' }}>{connection.data.client_id}</code></p></details>
          {active && <Button variant="danger" disabled={busy} onClick={() => void disconnect(connection)}>Revoke this connection</Button>}
        </article>;
      })}
      <div className="actions"><Button variant="secondary" disabled={busy || loading || connectionOffset === 0} onClick={() => { setBusy(true); setError(null); void reloadConnections(Math.max(0, connectionOffset - 20)).catch(setError).finally(() => setBusy(false)); }}>Previous connections</Button><span>{connectionTotal ? `${connectionOffset + 1}–${connectionOffset + connections.length} of ${connectionTotal}` : 'No connections'}</span><Button variant="secondary" disabled={busy || loading || connectionOffset + connections.length >= connectionTotal} onClick={() => { setBusy(true); setError(null); void reloadConnections(connectionOffset + 20).catch(setError).finally(() => setBusy(false)); }}>Next connections</Button><Button variant="secondary" disabled={busy || loading} onClick={() => { setBusy(true); setError(null); void reloadConnections().catch(setError).finally(() => setBusy(false)); }}>Reload granted access</Button></div>
    </section>}
  </>;
}
