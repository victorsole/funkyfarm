import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { RecordItem, Session } from '../types';

type Farm = { name?: string; country?: string; region?: string; farm_type?: string };
type Request = { farm_id: string; title: string; deadline?: string | null; status: string; recipient?: string };
type Task = { farm_id: string; title: string; description?: string; due_date?: string; status: string; request_id?: string };
type Invitation = { email: string; role: string; permissions: string[]; farm_ids: string[] | null; expires_at: string; revoked_at?: string | null; accepted_at?: string | null };
type Client = {
  workspace: Session['workspace']; farms: RecordItem<Farm>[]; requests: RecordItem<Request>[]; tasks: RecordItem<Task>[];
  review_counts: { facts: number; operations: number; purchases: number };
  totals: { farms: number; requests: number; tasks: number }; truncated: boolean;
  missing_information?: { report_id?: string; request_id?: string; code: string; message: string; field?: string; checked_at?: string; basis?: string }[];
};
type Overview = { clients: Client[]; total: number; limit: number; offset: number; mandate_notice: string };

function Delegation({ farms }: { farms: RecordItem<Farm>[] }) {
  const invitations = useRecords<Invitation>('invitations');
  const [email, setEmail] = useState('');
  const [selectedFarms, setSelectedFarms] = useState<string[]>([]);
  const [wholeWorkspace, setWholeWorkspace] = useState(false);
  const [review, setReview] = useState(false);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  async function invite(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setCode(''); setCopied(false);
    try {
      if (!wholeWorkspace && !selectedFarms.length) throw new Error('Choose the farms this adviser may access.');
      const result = await api.post<{ token: string }>('/invitations', { email, role: 'adviser', farm_ids: wholeWorkspace ? null : selectedFarms, permissions: review ? ['read', 'review'] : ['read'], expires_in_days: days });
      setCode(result.token); setEmail(''); await invitations.reload();
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try { await api.post(`/invitations/${id}/revoke`, {}); await invitations.reload(); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <section className="panel"><h2>Give an adviser access</h2><p>You choose which farms they can see and whether they can review evidence. They retain their own separate workspace.</p>
    {error && <Notice kind="error">{error}</Notice>}
    <form className="stack" onSubmit={invite}><div className="form-grid"><Field label="Adviser’s email"><input required type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} /></Field><Field label="Invitation expires in"><select value={days} onChange={event => setDays(Number(event.target.value))}>{[1, 7, 14, 30].map(value => <option key={value} value={value}>{value} {value === 1 ? 'day' : 'days'}</option>)}</select></Field></div>
      <fieldset><legend>Farms this adviser may access</legend>{farms.map(farm => <label className="checkbox-field" key={farm.id}><input disabled={wholeWorkspace} type="checkbox" checked={selectedFarms.includes(farm.id)} onChange={event => setSelectedFarms(previous => event.target.checked ? [...previous, farm.id] : previous.filter(value => value !== farm.id))} />{farm.data.name ?? farm.id}</label>)}<label className="checkbox-field"><input type="checkbox" checked={wholeWorkspace} onChange={event => setWholeWorkspace(event.target.checked)} />Grant the entire workspace, including future farms</label></fieldset>
      <label className="checkbox-field"><input type="checkbox" checked={review} onChange={event => setReview(event.target.checked)} />Allow reviewing and confirming evidence</label><p className="muted">Reading is included. This invitation grants access in FunkyFarm; it does not establish an official authority mandate.</p><Button type="submit" loading={busy}>Create private invitation</Button>
    </form>
    {code && <Notice kind="success"><p>Invitation created. Give this private code to the named adviser through a channel you choose. It is shown only here.</p><Field label="Private invitation code"><input type="password" readOnly value={code} autoComplete="off" /></Field><Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(code).then(() => setCopied(true)).catch(() => setError('The browser could not copy the code. Select it from the field to copy manually.')); }}>{copied ? 'Code copied' : 'Copy invitation code'}</Button></Notice>}
    <h3>Existing access invitations</h3>{invitations.loading ? <p role="status">Loading invitations…</p> : invitations.error ? <Notice kind="error">{invitations.error}</Notice> : !invitations.items.length ? <p className="muted">No adviser invitations have been created.</p> : <ul className="record-list">{invitations.items.map(invitation => <li key={invitation.id}><div className="record-main"><strong>{invitation.data.email}</strong><p>{invitation.data.farm_ids === null ? 'Whole workspace' : `${invitation.data.farm_ids.length} selected farms`} · {invitation.data.permissions.includes('review') ? 'Read and review' : 'Read only'}</p><p className="muted">{invitation.data.revoked_at ? 'Revoked' : invitation.data.accepted_at ? 'Accepted' : `Invitation expires ${new Date(invitation.data.expires_at).toLocaleDateString()}`}</p>{!invitation.data.revoked_at && <Button disabled={busy} variant="secondary" onClick={() => void revoke(invitation.id)}>Revoke invitation & access</Button>}</div></li>)}</ul>}
  </section>;
}

function FarmerQuestion({ farms, requests, onSaved }: { farms: RecordItem<Farm>[]; requests: RecordItem<Request>[]; onSaved: () => Promise<void> }) {
  const [params] = useSearchParams();
  const draft = usePrivateDraft(`adviser/farmer-question/${params.get('farm') ?? 'general'}`, { farm_id: params.get('farm') ?? '', request_id: params.get('request') ?? '', title: '', description: '', due_date: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try {
      await api.post('/adviser/ask-farmer', { farm_id: draft.value.farm_id, title: draft.value.title, description: draft.value.description, ...(draft.value.request_id ? { request_id: draft.value.request_id } : {}), ...(draft.value.due_date ? { due_date: draft.value.due_date } : {}) });
      await draft.clear(); setSaved(true); await onSaved();
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  if (!draft.ready) return <p role="status">Opening your private question draft…</p>;
  return <section className="panel"><h2>Ask the farmer</h2><p>Write a clear question or request a specific missing document. It becomes a private task in this workspace; no email or external message is sent.</p>{error && <Notice kind="error">{error}</Notice>}{draft.error && <Notice kind="error">{draft.error}</Notice>}{saved && <Notice kind="success">Question saved for the farmer in this workspace.</Notice>}
    <form onSubmit={submit} className="stack"><div className="form-grid"><Field label="Farm"><select required value={draft.value.farm_id} onChange={event => draft.setValue(previous => ({ ...previous, farm_id: event.target.value, request_id: '' }))}><option value="">Choose farm</option>{farms.map(farm => <option value={farm.id} key={farm.id}>{farm.data.name ?? farm.id}</option>)}</select></Field><Field label="Related paperwork, if any"><select value={draft.value.request_id} onChange={event => draft.setValue(previous => ({ ...previous, request_id: event.target.value }))}><option value="">General farm question</option>{requests.filter(request => request.data.farm_id === draft.value.farm_id).map(request => <option value={request.id} key={request.id}>{request.data.title}</option>)}</select></Field><Field label="Reply needed by, if applicable"><input type="date" value={draft.value.due_date} onChange={event => draft.setValue(previous => ({ ...previous, due_date: event.target.value }))} /></Field></div>
      <Field label="Question"><input required maxLength={180} value={draft.value.title} onChange={event => draft.setValue(previous => ({ ...previous, title: event.target.value }))} placeholder="Could you add the supplier invoice for this purchase?" /></Field><Field label="What the farmer needs to provide"><textarea required rows={4} value={draft.value.description} onChange={event => draft.setValue(previous => ({ ...previous, description: event.target.value }))} placeholder="Explain the document, date or answer you need and why." /></Field><p className="muted" role="status">{draft.saving ? 'Saving private draft on this device…' : 'Saved questions appear in the farmer’s task list.'}</p><Button type="submit" disabled={draft.saving} loading={busy}>Save question for farmer</Button>
    </form>
  </section>;
}

export function AdviserPage() {
  const { session, switchWorkspace, refresh } = useSession();
  const navigate = useNavigate();
  const farms = useRecords<Farm>('farms');
  const requests = useRecords<Request>('requests');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [invitationCode, setInvitationCode] = useState('');
  const [accepted, setAccepted] = useState('');
  const owner = session?.workspace.role === 'owner';
  const canReview = owner || session?.workspace.permissions?.includes('review') === true;
  async function load() {
    setLoading(true); setError('');
    try { setOverview(await api.get<Overview>(`/adviser/overview?limit=20&offset=${offset}`)); }
    catch (failure) { setError(errorMessage(failure)); } finally { setLoading(false); }
  }
  useEffect(() => { setOverview(null); void load(); }, [session?.workspace.id, offset]);
  async function open(workspaceId: string, path: string) {
    setBusy(true); setError('');
    try { await switchWorkspace(workspaceId); navigate(path); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function accept(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setAccepted('');
    try { await api.post('/invitations/accept', { token: invitationCode.trim() }); setInvitationCode(''); await refresh(); await load(); setAccepted('Invitation accepted. The farm workspace is now available in your workspace selector. Your own records remain separate.'); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <>
    <PageHeader title="Adviser desk" description="A working view of the farms that have given you access, and the questions that need a person’s attention." />
    {error && <Notice kind="error">{error}<Button variant="ghost" onClick={() => void load()}>Retry</Button></Notice>}{accepted && <Notice kind="success">{accepted}</Notice>}
    <section className="panel"><div className="section-heading"><h2>Farms on your desk</h2><span className="badge">{overview?.total ?? '…'} workspaces</span></div>{loading ? <p role="status">Checking your current farm permissions…</p> : !overview?.clients.length ? <div className="empty-state"><h3>Your first farm starts with permission</h3><p>Accept a farmer’s private invitation below. Each farm stays in its own workspace.</p></div> : overview.clients.map(client => <article className="evidence-card" key={client.workspace.id}>
      <div className="section-heading"><h3>{client.workspace.name}</h3><span className="badge">{client.workspace.role === 'owner' || client.workspace.permissions?.includes('review') ? 'Read & review' : 'Read only'}</span></div><p className="muted">{client.workspace.farm_ids === null ? 'Access to the whole workspace' : 'Access limited to permitted farms'} · {client.totals.farms} farms</p>
      <div className="form-grid"><div><strong>{client.review_counts.facts + client.review_counts.operations + client.review_counts.purchases}</strong><p>Recorded proposals awaiting review</p></div><div><strong>{client.tasks.length}</strong><p>Open questions and follow-up tasks in this view</p></div></div>
      {client.farms.map(farm => <div className="panel inset" key={farm.id}><div className="section-heading"><h4>{farm.data.name ?? 'Farm'}</h4><span className="muted">{farm.data.country}{farm.data.region ? ` · ${farm.data.region}` : ''}</span></div><div className="actions"><Button variant="secondary" disabled={busy} onClick={() => void open(client.workspace.id, `/app/farm/${farm.id}`)}>Open farm & evidence</Button>{(client.workspace.role === 'owner' || client.workspace.permissions?.includes('review')) && <Button variant="ghost" disabled={busy} onClick={() => void open(client.workspace.id, `/app/adviser?farm=${farm.id}`)}>Ask this farmer</Button>}</div>
        <ul className="record-list">{client.requests.filter(request => request.data.farm_id === farm.id).map(request => <li key={request.id}><div className="record-main"><strong>{request.data.title}</strong><p>{request.data.deadline ? `Due ${request.data.deadline}` : 'No deadline recorded'} · {request.data.status}</p><Button variant="ghost" disabled={busy} onClick={() => void open(client.workspace.id, `/app/paperwork/${request.id}`)}>Open paperwork</Button></div></li>)}</ul>
      </div>)}
      {!!client.missing_information?.length && <details><summary>Draft checks to revisit ({client.missing_information.length})</summary><p className="muted">These are saved draft checks. Open the response to refresh its current evidence and requirements.</p><ul>{client.missing_information.map((item, index) => <li key={`${item.report_id}-${index}`}>{item.message}{item.checked_at ? ` · Checked ${new Date(item.checked_at).toLocaleDateString()}` : ''}{item.report_id && <Button variant="ghost" disabled={busy} onClick={() => void open(client.workspace.id, `/app/reports/${item.report_id}`)}>Review current response</Button>}</li>)}</ul></details>}
      {!!client.tasks.length && <details><summary>Farmer questions & follow-up</summary><ul>{client.tasks.map(task => <li key={task.id}><strong>{task.data.title}</strong>{task.data.description && <p>{task.data.description}</p>}<p className="muted">{task.data.status}{task.data.due_date ? ` · Due ${task.data.due_date}` : ''}</p></li>)}</ul></details>}{client.truncated && <Notice>This workspace has more records. Open its farms for the complete current view.</Notice>}
    </article>)}
      {overview && overview.total > overview.limit && <div className="actions"><Button variant="ghost" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous workspaces</Button><Button variant="ghost" disabled={offset + overview.limit >= overview.total || loading} onClick={() => setOffset(value => value + 20)}>Next workspaces</Button></div>}
      <p className="muted">{overview?.mandate_notice ?? 'Access here is delegated by the farmer. Official agency representation may require a separate authority mandate.'}</p>
    </section>
    {farms.error && <Notice kind="error">{farms.error}</Notice>}{requests.error && <Notice kind="error">{requests.error}</Notice>}
    {canReview && !farms.loading && !!farms.items.length && <FarmerQuestion key={session?.workspace.id} farms={farms.items} requests={requests.items} onSaved={load} />}
    <section className="panel"><h2>Accept a farmer’s invitation</h2><p>Use the private code addressed to your signed-in email. Acceptance adds only the access the farmer chose.</p><form className="stack" onSubmit={accept}><Field label="Private invitation code"><input required type="password" autoComplete="off" value={invitationCode} onChange={event => setInvitationCode(event.target.value)} /></Field><Button type="submit" loading={busy}>Accept invitation</Button></form></section>
    {owner && !farms.loading && <Delegation key={session?.workspace.id} farms={farms.items} />}
  </>;
}
