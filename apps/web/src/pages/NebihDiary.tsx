import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice } from '../components';
import type { Page, RecordItem } from '../types';

type Connection = RecordItem<{ farm_id: string; status: string; credentials_present: boolean }>;
type SourceValue = { name: string; text: string | null; children: SourceValue[]; attributes?: Record<string, string> };
type DiaryResult = {
  environment: string; operation: string; blocked: boolean; notice?: string;
  messages: { code?: string; severity?: string; text?: string }[];
  payload: SourceValue | null; sites?: { id: string | null; uses: { id: string | null }[] }[];
  page?: number; page_size?: number; total_sites?: number | null; number_returned?: number;
};
type DiaryRead = RecordItem<{ connection_revision: number; read_kind: string; read_at: string; result: DiaryResult }>;

function sourceRows(payload: SourceValue | null) {
  const rows: { label: string; value: string | null; oversized?: boolean }[] = [];
  const pending = payload ? [{ node: payload, path: '' }] : [];
  let visited = 0; let characters = 0; let limited = false;
  while (pending.length && visited < 5000 && rows.length < 500) {
    const { node, path } = pending.pop()!; visited += 1;
    const label = path ? `${path} / ${node.name}` : node.name;
    const nil = ['true', '1'].includes(node.attributes?.['{http://www.w3.org/2001/XMLSchema-instance}nil'] || '');
    if (nil || !node.children.length || node.text !== null) {
      const raw = nil ? null : node.text;
      const oversized = (raw?.length ?? 0) > 50000 - characters;
      rows.push({ label, value: oversized ? null : raw, oversized });
      if (oversized) limited = true; else characters += raw?.length ?? 0;
    }
    for (const [name, raw] of Object.entries(node.attributes || {})) {
      if (name === '{http://www.w3.org/2001/XMLSchema-instance}nil') continue;
      if (rows.length >= 500) { limited = true; break; }
      const oversized = raw.length > 50000 - characters;
      rows.push({ label: `${label} / ${name}`, value: oversized ? null : raw, oversized });
      if (oversized) limited = true; else characters += raw.length;
    }
    const available = Math.max(0, 5000 - visited - pending.length);
    if (node.children.length > available) limited = true;
    for (let index = Math.min(node.children.length, available) - 1; index >= 0; index -= 1) pending.push({ node: node.children[index], path: label });
  }
  return { rows, limited: limited || pending.length > 0 };
}

function ReadDetails({ record }: { record: DiaryRead }) {
  const [showValues, setShowValues] = useState(false);
  const [offset, setOffset] = useState(0);
  const preview = useMemo(() => showValues ? sourceRows(record.data.result.payload) : { rows: [], limited: false }, [showValues, record.data.result.payload]);
  function value(key: string) {
    const nodes = record.data.result.payload?.children.filter(child => child.name === key) || [];
    const nil = nodes[0]?.attributes?.['{http://www.w3.org/2001/XMLSchema-instance}nil'];
    return nodes.length === 1 && !nodes[0].children.length && !['true', '1'].includes(nil || '') && nodes[0].text !== null ? nodes[0].text === '' ? 'Blank text' : nodes[0].text : 'Not supplied';
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record.data, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'nebih-diary-read.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="connection-result">
    <p>Read on {new Date(record.data.read_at).toLocaleString()}. Source environment: {record.data.result.environment}.</p>
    {record.data.result.environment === 'test' && <Notice kind="warning">These are test-service records, not production farm records.</Notice>}
    {record.data.read_kind === 'fields' && <dl className="evidence-list">{[['gn-naplo-id', 'Diary reference'], ['partner-id', 'Farmer reference at Nébih'], ['gazdalkodas-ev-kod', 'Reporting year code'], ['ervenyesseg-kezd', 'Valid from'], ['ervenyesseg-veg', 'Valid until']].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{value(key)}</dd></div>)}</dl>}
    {record.data.result.blocked && <Notice kind="warning">Nébih returned a problem or a message we cannot safely interpret. Check its messages before trying again. These values cannot be used to select another read.</Notice>}
    {!!record.data.result.messages.length && <section><h3>Messages from Nébih</h3><ul>{record.data.result.messages.map((message, index) => <li key={index}>{message.text || 'No message text supplied'}{message.code && <small className="muted"> · source code {message.code}</small>}</li>)}</ul></section>}
    <p>Nothing in this read has changed your field boundaries, confirmed farm records or official diary.</p>
    <Button variant="secondary" onClick={download}>Download this saved read</Button>
    <Button variant="ghost" aria-expanded={showValues} onClick={() => setShowValues(value => !value)}>{showValues ? 'Hide source values' : 'See the retained source values'}</Button>
    {showValues && <section aria-label="Retained Nébih source values"><p className="muted">Source labels and codes are kept as returned. Download the saved read for the complete original values.</p>{preview.rows.length ? <><dl className="evidence-list">{preview.rows.slice(offset, offset + 20).map((row, index) => <div key={offset + index}><dt style={{ overflowWrap: 'anywhere' }}>{row.label}</dt><dd style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.oversized ? 'Long value: available in the saved download' : row.value === null ? 'Not supplied' : row.value === '' ? 'Blank text' : row.value}</dd></div>)}</dl><div className="actions"><Button variant="secondary" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous values</Button><span>{offset + 1}–{Math.min(offset + 20, preview.rows.length)} of {preview.rows.length} preview values</span><Button variant="secondary" disabled={offset + 20 >= preview.rows.length} onClick={() => setOffset(value => value + 20)}>Next values</Button></div></> : <p>No source values were returned.</p>}{preview.limited && <p className="muted">This preview is limited. The saved download retains the complete read without shortening values.</p>}</section>}
  </div>;
}

export function NebihDiary({ connection, configurationReady, reload }: { connection: Connection; configurationReady: boolean; reload: () => Promise<void> }) {
  const { session } = useSession();
  const [token, setToken] = useState('');
  const [consent, setConsent] = useState(false);
  const [page, setPage] = useState(1);
  const [read, setRead] = useState<DiaryRead | null>(null);
  const [operations, setOperations] = useState<DiaryRead | null>(null);
  const [history, setHistory] = useState<DiaryRead[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const inFlight = useRef(false);
  const owner = session?.workspace.role === 'owner';
  const canRead = owner || session?.workspace.role === 'adviser';
  const currentRead = read?.data.connection_revision === connection.revision;
  const sites = read?.data.result.sites || [];
  const more = read && (read.data.result.total_sites == null
    ? sites.length === read.data.result.page_size
    : (read.data.result.page || 1) * (read.data.result.page_size || 50) < read.data.result.total_sites);

  useEffect(() => {
    generation.current += 1; setToken(''); setConsent(false); setPage(1); setRead(null); setOperations(null); setHistory([]); setError('');
    return () => { generation.current += 1; };
  }, [connection.id, connection.revision, session?.user.id, session?.workspace.id]);

  async function act(operation: (current: () => boolean) => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    const start = generation.current;
    setBusy(true); setError(''); setMessage('');
    try { await operation(() => generation.current === start); }
    catch (failure) { if (generation.current === start) setError(errorMessage(failure)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function readPage(selectedPage: number, current: () => boolean) {
    const result = await api.post<DiaryRead>(`/connections/${connection.id}/read-diary`, { expected_revision: connection.revision, consent: true, page: selectedPage, page_size: 50 });
    if (current()) { setRead(result); setOperations(null); setPage(selectedPage); }
  }

  return <section className="paper-section" aria-labelledby="nebih-diary-heading">
    <h2 id="nebih-diary-heading">Read records you already keep at Nébih</h2>
    <p>This can save copying records by hand. First check that the diary belongs to this farm and covers the year you need. A read does not submit or change anything at Nébih.</p>
    {!configurationReady && <Notice>Authority setup is not available yet. The operator needs approved service access before you can use this connection. You do not need to enter a token now.</Notice>}
    {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}
    {configurationReady && <>
      {owner ? <details open={!connection.data.credentials_present}><summary>{connection.data.credentials_present ? 'Replace my saved diary token' : 'Add my diary token'}</summary>
        <p>Sign in to your eGN diary through Nébih’s own customer profile. Open the correct diary and use Token generálás or Token információk. Copy that diary’s token here. Do not enter your government sign-in password.</p>
        <form onSubmit={event => { event.preventDefault(); void act(async current => {
          await api.post(`/connections/${connection.id}/credentials`, { expected_revision: connection.revision, api_key: token });
          if (current()) { setToken(''); setMessage('Diary token saved encrypted. Enable read access separately.'); await reload(); }
        }); }}><Field label="Token for this farm’s eGN diary"><input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} maxLength={50} required disabled={busy} /></Field><Button type="submit" disabled={busy || !token.trim()}>Save diary token</Button></form>
      </details> : !connection.data.credentials_present && <p>Ask the farm owner to add the diary token. A sharing invitation alone does not give authority access.</p>}
      {connection.data.credentials_present && connection.data.status !== 'private_read_enabled' && <Button disabled={busy || !canRead} onClick={() => void act(async current => {
        await api.post(`/connections/${connection.id}/activate`, { expected_revision: connection.revision });
        if (current()) await reload();
      })}>Enable read access</Button>}
      {connection.data.status === 'private_read_enabled' && <div>
        <label className="check-row"><input type="checkbox" checked={consent} onChange={event => { setConsent(event.target.checked); if (!event.target.checked) { generation.current += 1; setRead(null); setOperations(null); } }} />This token is for this farm’s diary, and I have permission to read it here.</label>
        <p>Read up to 50 fields at a time. Another page is fetched only when you ask for it.</p>
        <Button disabled={busy || !consent || !canRead} onClick={() => void act(current => readPage(1, current))}>{busy ? 'Reading…' : 'Read my diary fields'}</Button>
        {read?.data.read_kind === 'fields' && <div><p>Page {read.data.result.page}. {read.data.result.number_returned ?? 0} field records returned. {read.data.result.total_sites == null ? 'The total number of fields is not known.' : `${read.data.result.total_sites} field records reported by the source.`}</p>
          <div className="actions"><Button variant="secondary" disabled={busy || !consent || !currentRead || page <= 1} onClick={() => void act(current => readPage(page - 1, current))}>Read previous page</Button><Button variant="secondary" disabled={busy || !consent || !currentRead || !more || page >= 100000} onClick={() => void act(current => readPage(page + 1, current))}>Read next page</Button></div>
          {!currentRead && <Notice kind="warning">This read used an earlier connection version. Read the fields again before selecting work records.</Notice>}
          {!read.data.result.blocked && <section><h3>Choose the work records you need</h3>{sites.length ? sites.map((site, index) => <article key={`${site.id}:${index}`}><h4>{site.id ? `Field reference ${site.id}` : `Field ${index + 1}, reference not supplied`}</h4>{site.id && site.uses.some(use => use.id) ? site.uses.filter(use => use.id).map((use, useIndex) => <Button key={`${use.id}:${useIndex}`} variant="secondary" disabled={busy || !consent || !currentRead || !canRead} onClick={() => void act(async current => {
            const result = await api.post<DiaryRead>(`/connections/${connection.id}/read-diary-operations`, { expected_revision: connection.revision, consent: true, field_read_id: read.id, site_id: site.id, use_id: use.id });
            if (current()) setOperations(result);
          })}>Read work for crop-use reference {use.id}</Button>) : <p>No crop-use reference was supplied for this field.</p>}</article>) : <p>No fields were returned on this page. This does not establish that the farm has no fields.</p>}</section>}
        </div>}
      </div>}
    </>}
    {read && <ReadDetails key={read.id} record={read} />}
    {operations && <section><h3>Saved work records</h3><ReadDetails key={operations.id} record={operations} /></section>}
    <details><summary>Earlier saved reads</summary><p>Older reads may refer to an earlier token, diary state or year. They are not live updates.</p><Button variant="secondary" disabled={busy || !canRead} onClick={() => void act(async current => {
      const result = await api.get<Page<DiaryRead>>(`/connections/${connection.id}/reads?limit=20`);
      if (current()) { setHistory(result.items); if (result.total > 20) setMessage('Showing the latest 20 reads. Earlier records remain saved in the farm workspace.'); }
    })}>Show saved reads</Button>{history.map(item => <p key={item.id}><Button variant="ghost" disabled={busy} onClick={() => { if (item.data.read_kind === 'fields') { setRead(item); setOperations(null); setPage(item.data.result.page || 1); } else setOperations(item); }}>Open saved {item.data.read_kind === 'fields' ? 'field' : 'work'} read from {new Date(item.data.read_at).toLocaleString()}</Button></p>)}</details>
  </section>;
}
