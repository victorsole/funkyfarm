import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { RecordItem, Session } from '../types';
import './people-pages.css';

type Farm = { name?: string; country?: string; region?: string; farm_type?: string };
type Request = { farm_id: string; title: string; deadline?: string | null; status: string; recipient?: string };
type Task = { farm_id: string; title: string; description?: string; notes?: string; due_date?: string; status: string; request_id?: string };
type Invitation = { email: string; role: string; permissions: string[]; farm_ids: string[] | null; expires_at: string; revoked_at?: string | null; accepted_at?: string | null };
type Case = { farm_id: string; title: string; job_type: 'fields' | 'correction' | 'inspection'; status: string; reporting_year: number; deadline?: string | null };
type Client = {
  workspace: Session['workspace']; farms: RecordItem<Farm>[]; requests: RecordItem<Request>[]; tasks: RecordItem<Task>[];
  admin_cases: RecordItem<Case>[]; case_counts: Record<string, number>;
  review_counts: { facts: number; operations: number; purchases: number };
  totals: { farms: number; requests: number; tasks: number; admin_cases: number }; truncated: boolean;
  missing_information?: { farm_id?: string; report_id?: string; request_id?: string; code: string; message: string; field?: string; checked_at?: string; basis?: string }[];
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
  return <section className="panel"><h2>Give an adviser access</h2><p>Choose the farms they can see and whether they may check and confirm records.</p>
    {error && <Notice kind="error">{error}</Notice>}
    <form className="stack" onSubmit={invite}><div className="form-grid"><Field label="Adviser’s email"><input required type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} /></Field><Field label="Invitation expires in"><select value={days} onChange={event => setDays(Number(event.target.value))}>{[1, 7, 14, 30].map(value => <option key={value} value={value}>{value} {value === 1 ? 'day' : 'days'}</option>)}</select></Field></div>
      <fieldset><legend>Farms this adviser may access</legend>{farms.map(farm => <label className="checkbox-field" key={farm.id}><input disabled={wholeWorkspace} type="checkbox" checked={selectedFarms.includes(farm.id)} onChange={event => setSelectedFarms(previous => event.target.checked ? [...previous, farm.id] : previous.filter(value => value !== farm.id))} />{farm.data.name ?? farm.id}</label>)}<label className="checkbox-field"><input type="checkbox" checked={wholeWorkspace} onChange={event => setWholeWorkspace(event.target.checked)} />Grant the entire workspace, including future farms</label></fieldset>
      <label className="checkbox-field"><input type="checkbox" checked={review} onChange={event => setReview(event.target.checked)} />Allow checking and confirming records</label><p className="muted">Reading is included. This invitation grants access in FunkyFarm; it does not establish an official authority mandate.</p><Button type="submit" loading={busy}>Create private invitation</Button>
    </form>
    {code && <Notice kind="success"><p>Invitation created. Give this private code to the named adviser through a channel you choose. It is shown only here.</p><Field label="Private invitation code"><input type="password" readOnly value={code} autoComplete="off" /></Field><Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(code).then(() => setCopied(true)).catch(() => setError('The browser could not copy the code. Select it from the field to copy manually.')); }}>{copied ? 'Code copied' : 'Copy invitation code'}</Button></Notice>}
    <h3>Existing access invitations</h3>{invitations.loading ? <p role="status">Loading invitations…</p> : invitations.error ? <Notice kind="error">{invitations.error}</Notice> : !invitations.items.length ? <p className="muted">No adviser invitations have been created.</p> : <ul className="record-list">{invitations.items.map(invitation => <li key={invitation.id}><div className="record-main"><strong>{invitation.data.email}</strong><p>{invitation.data.farm_ids === null ? 'Whole workspace' : `${invitation.data.farm_ids.length} selected farms`} · {invitation.data.permissions.includes('review') ? 'Read and review' : 'Read only'}</p><p className="muted">{invitation.data.revoked_at ? 'Revoked' : invitation.data.accepted_at ? 'Accepted' : `Invitation expires ${new Date(invitation.data.expires_at).toLocaleDateString()}`}</p>{!invitation.data.revoked_at && <Button disabled={busy} variant="secondary" onClick={() => void revoke(invitation.id)}>Revoke invitation & access</Button>}</div></li>)}</ul>}
  </section>;
}

function FarmerQuestion({ farms, requests, farmId, onSaved }: { farms: RecordItem<Farm>[]; requests: RecordItem<Request>[]; farmId: string; onSaved: () => Promise<void> }) {
  const [params] = useSearchParams();
  const draft = usePrivateDraft(`adviser/farmer-question/${farmId}`, { farm_id: farmId, request_id: params.get('request') ?? '', title: '', description: '', due_date: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try {
      if (draft.value.farm_id !== farmId) throw new Error('Choose this farm again before saving the question.');
      if (draft.value.request_id && !requests.some(request => request.id === draft.value.request_id && request.data.farm_id === farmId)) throw new Error('The related paperwork is no longer available for this farm. Choose it again.');
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
  const [params] = useSearchParams();
  const farms = useRecords<Farm>('farms');
  const requests = useRecords<Request>('requests');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewBinding, setOverviewBinding] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [panel, setPanel] = useState<'question' | 'accept' | 'invite' | null>(null);
  const [invitationCode, setInvitationCode] = useState('');
  const [accepted, setAccepted] = useState('');
  const detailRef = useRef<HTMLElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const binding = `${session?.workspace.id}/${offset}`;
  const currentBinding = useRef(binding);
  currentBinding.current = binding;
  const visibleOverview = overviewBinding === binding ? overview : null;
  const owner = session?.workspace.role === 'owner';
  const canReview = owner || session?.workspace.permissions?.includes('review') === true;
  async function load() {
    const attempt = ++generation.current;
    const context = binding;
    setLoading(true); setError('');
    try {
      const result = await api.get<Overview>(`/adviser/overview?limit=20&offset=${offset}`);
      if (attempt === generation.current && context === currentBinding.current) { setOverview(result); setOverviewBinding(context); }
    } catch (failure) { if (attempt === generation.current && context === currentBinding.current) setError(errorMessage(failure)); }
    finally { if (attempt === generation.current && context === currentBinding.current) setLoading(false); }
  }
  useEffect(() => {
    setOverview(null); setSelectedKey(''); setPanel(null); setInvitationCode(''); setAccepted(''); void load();
    return () => { generation.current += 1; };
  }, [session?.workspace.id, offset]);
  useEffect(() => {
    const farmId = params.get('farm');
    if (!farmId || !visibleOverview) return;
    const client = visibleOverview.clients.find(item => item.workspace.id === session?.workspace.id && item.farms.some(farm => farm.id === farmId));
    if (client) { setSelectedKey(`${client.workspace.id}/${farmId}`); if (params.get('ask') === '1' && canReview) setPanel('question'); }
  }, [visibleOverview, params, session?.workspace.id, canReview]);
  function focusSection(node: HTMLElement | null) {
    if (!node) return;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  useEffect(() => { if (selectedKey) focusSection(detailRef.current); }, [selectedKey]);
  useEffect(() => { if (panel) focusSection(actionRef.current); }, [panel, selectedKey]);
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
  const choices = (visibleOverview?.clients ?? []).flatMap(client => client.farms.map(farm => ({ client, farm, key: `${client.workspace.id}/${farm.id}` })));
  const selected = choices.find(item => item.key === selectedKey);
  const needle = search.trim().toLocaleLowerCase();
  const filtered = choices.filter(({ client, farm }) => `${client.workspace.name} ${farm.data.name ?? ''} ${farm.data.country ?? ''} ${farm.data.region ?? ''}`.toLocaleLowerCase().includes(needle));
  const selectedCanReview = !!selected && (selected.client.workspace.role === 'owner' || selected.client.workspace.permissions?.includes('review') === true);
  const selectedCases = (selected?.client.admin_cases ?? []).filter(item => item.data.farm_id === selected?.farm.id);
  const selectedTasks = selected?.client.tasks.filter(item => item.data.farm_id === selected.farm.id) ?? [];
  const selectedRequests = selected?.client.requests.filter(item => item.data.farm_id === selected.farm.id) ?? [];
  const statusLabel = (status: string) => (({ draft: 'Needs preparation', ready_to_send: 'Prepared for manual sending', sent: 'Sending recorded by a person', receipt_saved: 'Receipt recorded by a person', accepted_recorded: 'Acceptance recorded by a person', needs_changes: 'Changes requested', cancelled: 'Set aside' } as Record<string, string>)[status] ?? status.replaceAll('_', ' '));
  return <>
    <PageHeader title="Adviser desk" description="Choose a farm, see what is missing and help with its next task." />
    {error && <Notice kind="error">{error}<Button variant="ghost" onClick={() => void load()}>Retry</Button></Notice>}{accepted && <Notice kind="success">{accepted}</Notice>}
    <section className="panel"><div className="section-heading"><h2>Farms on your desk</h2><span className="badge">{visibleOverview?.total ?? '…'} workspaces</span></div>
      <Field label="Search farms or clients"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Farm name, client or country" /></Field>
      {loading ? <p role="status">Checking your current farm permissions…</p> : !choices.length ? <p>Your first farm starts with permission. Accept a farmer’s private invitation to add their workspace.</p> : !filtered.length ? <p>No farms match in this loaded view. Try another name or workspace page.</p> : <ul className="record-list">{filtered.map(({ client, farm, key }) => <li key={key}><div className="record-main"><strong>{farm.data.name ?? 'Farm'}</strong><p>{client.workspace.name} · {farm.data.country}{farm.data.region ? ` · ${farm.data.region}` : ''} · {client.workspace.role === 'owner' || client.workspace.permissions?.includes('review') ? 'Read & review' : 'Read only'}</p></div><Button variant={selectedKey === key ? 'secondary' : 'ghost'} disabled={busy} aria-expanded={selectedKey === key} aria-controls={selectedKey === key ? 'adviser-selected-farm' : undefined} onClick={() => { setSelectedKey(key); setPanel(null); }}>Open farm · {farm.data.name ?? 'Farm'}</Button></li>)}</ul>}
      {visibleOverview && visibleOverview.total > visibleOverview.limit && <div className="actions"><Button variant="ghost" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous workspaces</Button><Button variant="ghost" disabled={offset + visibleOverview.limit >= visibleOverview.total || loading} onClick={() => setOffset(value => value + 20)}>Next workspaces</Button></div>}
      {visibleOverview?.clients.some(client => client.truncated) && <p className="muted">Search covers the loaded farms only. A workspace may have more records; open its farm for the complete view.</p>}
      <p className="muted">{visibleOverview?.mandate_notice ?? 'Farm access here does not establish an official authority mandate.'}</p>
    </section>
    {selected && <section ref={detailRef} tabIndex={-1} id="adviser-selected-farm" className="panel" aria-label={`Selected farm · ${selected.farm.data.name ?? 'Farm'}`}><div className="section-heading"><h2>{selected.farm.data.name ?? 'Farm'}</h2><Button variant="ghost" onClick={() => { setSelectedKey(''); setPanel(null); }}>Close farm</Button></div>
      <p>{selectedCanReview ? 'You can read and check this farm’s records. Changes still need a separate approval.' : 'Read only. You can see the records, but cannot change or approve them.'}</p>
      <div className="actions"><Button disabled={busy} onClick={() => void open(selected.client.workspace.id, `/app/fields/${selected.farm.id}/check`)}>Check parcels</Button><Button variant="secondary" disabled={busy} onClick={() => void open(selected.client.workspace.id, `/app/farm/${selected.farm.id}`)}>Open farm records</Button>{selectedCanReview && <Button variant="ghost" disabled={busy} onClick={() => { if (selected.client.workspace.id === session?.workspace.id) setPanel('question'); else void open(selected.client.workspace.id, `/app/adviser?farm=${selected.farm.id}&ask=1`); }}>Ask this farmer</Button>}</div>
      <h3>Corrections and inspections</h3>{selectedCases.length ? <ul className="record-list">{selectedCases.map(item => <li key={item.id}><div className="record-main"><strong>{item.data.title}</strong><p>{statusLabel(item.data.status)} · {item.data.reporting_year}{item.data.deadline ? ` · Recorded date ${item.data.deadline}` : ''}</p></div><Button variant="secondary" disabled={busy} onClick={() => void open(selected.client.workspace.id, `/app/cases/${item.id}${item.data.job_type === 'correction' ? '/correction' : ''}`)}>Open {item.data.job_type === 'correction' ? 'correction' : item.data.job_type === 'inspection' ? 'inspection' : 'parcel case'} · {item.data.title}</Button></li>)}</ul> : <p>No case is saved for this farm in the loaded view.</p>}
      <p className="muted">{selected.client.totals.admin_cases ?? 0} cases in permitted farms across this workspace · {selected.client.case_counts?.draft ?? 0} drafts · {selected.client.case_counts?.needs_changes ?? 0} with changes requested. These counts describe work in the app, not an authority decision.</p>
      <Button variant="ghost" disabled={busy} onClick={() => void open(selected.client.workspace.id, `/app/cases?farm_id=${selected.farm.id}`)}>All cases for this farm</Button>
      <section className="adviser-follow-up" aria-label="Paperwork and questions"><h3>Paperwork</h3>{selectedRequests.length ? <ul className="record-list">{selectedRequests.map(request => <li key={request.id}><strong>{request.data.title}</strong><p>{request.data.deadline ? `Recorded date ${request.data.deadline}` : 'No deadline recorded'} · {request.data.status}</p><Button variant="ghost" disabled={busy} onClick={() => void open(selected.client.workspace.id, `/app/paperwork/${request.id}`)}>Open paperwork</Button></li>)}</ul> : <p>No paperwork in this loaded view.</p>}
        <h3>Farmer questions and follow-up</h3>{selectedTasks.length ? <ul>{selectedTasks.map(task => <li key={task.id}><strong>{task.data.title}</strong>{task.data.description && <p>{task.data.description}</p>}{task.data.notes && <p>Saved answer: {task.data.notes}</p>}<p>{task.data.status}{task.data.due_date ? ` · Due ${task.data.due_date}` : ''}</p><Button variant="ghost" disabled={busy} onClick={() => void open(selected.client.workspace.id, `/app/tasks/${task.id}`)}>Open question and answer</Button></li>)}</ul> : <p>No questions in this loaded view.</p>}<Button variant="ghost" disabled={busy} onClick={() => void open(selected.client.workspace.id, `/app/tasks?farm_id=${selected.farm.id}`)}>Questions and answers</Button>
        {selected.client.missing_information?.filter(item => item.farm_id === selected.farm.id).map((item, index) => <p key={`${item.report_id}-${index}`}>{item.message}{item.checked_at ? ` · Saved check ${new Date(item.checked_at).toLocaleDateString()}` : ''}{item.report_id && <Button variant="ghost" disabled={busy} onClick={() => void open(selected.client.workspace.id, `/app/reports/${item.report_id}`)}>Review current response</Button>}</p>)}
      </section>{selected.client.truncated && <Notice>This workspace has more records. Open the farm or its full case list for the complete current view.</Notice>}
    </section>}
    <div className="actions"><Button variant="secondary" aria-expanded={panel === 'accept'} onClick={() => setPanel(panel === 'accept' ? null : 'accept')}>Accept a farmer’s invitation</Button>{owner && <Button variant="ghost" aria-expanded={panel === 'invite'} onClick={() => setPanel(panel === 'invite' ? null : 'invite')}>Give an adviser access</Button>}</div>
    {panel && <div ref={actionRef} tabIndex={-1} className="panel" aria-label={panel === 'question' ? 'Question for selected farm' : panel === 'accept' ? 'Accept invitation form' : 'Adviser invitation form'}><Button variant="ghost" onClick={() => setPanel(null)}>Close form</Button>
      {panel === 'question' && selected && selectedCanReview && selected.client.workspace.id === session?.workspace.id && canReview && <><p>Question for {selected.farm.data.name ?? 'this farm'}.</p>{requests.error ? <Notice kind="error">{requests.error}</Notice> : requests.loading ? <p role="status">Loading this farm’s paperwork…</p> : <FarmerQuestion key={`${session?.workspace.id}/${selected.farm.id}`} farmId={selected.farm.id} farms={[selected.farm]} requests={requests.items} onSaved={load} />}</>}
      {panel === 'accept' && <section><h2>Accept a farmer’s invitation</h2><p>Use the private code addressed to your signed-in email. Acceptance adds only the access the farmer chose.</p><form className="stack" onSubmit={accept}><Field label="Private invitation code"><input required type="password" autoComplete="off" value={invitationCode} onChange={event => setInvitationCode(event.target.value)} /></Field><Button type="submit" loading={busy}>Accept invitation</Button></form></section>}
      {panel === 'invite' && owner && (farms.error ? <Notice kind="error">{farms.error}</Notice> : farms.loading ? <p role="status">Loading permitted farms…</p> : <Delegation key={session?.workspace.id} farms={farms.items} />)}
    </div>}
  </>;
}
