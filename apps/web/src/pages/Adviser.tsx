import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { Page, RecordItem, Session } from '../types';
import './people-pages.css';
import './adviser-desk.css';

type Farm = { name?: string; country?: string; region?: string; farm_type?: string };
type Request = { farm_id: string; title: string; deadline?: string | null; status: string; recipient?: string };
type Task = { farm_id: string; title: string; description?: string; notes?: string; due_date?: string; status: string; request_id?: string };
type Invitation = { email: string; role: string; permissions: string[]; farm_ids: string[] | null; expires_at: string; revoked_at?: string | null; accepted_at?: string | null };
type Case = { farm_id: string; title: string; job_type: 'fields' | 'correction' | 'inspection'; status: string; reporting_year: number; deadline?: string | null };
type Overview = Page<Session['workspace']> & { mandate_notice: string };
type Selection = { workspaceId: string; farmId: string };
type FarmDetail = {
  workspace: Session['workspace']; farm: RecordItem<Farm>; tasks: Page<RecordItem<Task>>;
  requests: Page<RecordItem<Request>>; admin_cases: Page<RecordItem<Case>>;
  review_counts: { facts: number; operations: number; purchases: number; sales: number };
  case_counts: Record<string, number>;
  schedule: { overdue: number; upcoming: number; undated: number; today: string; through: string;
    items: Array<{ id: string; kind: 'tasks' | 'requests' | 'admin_cases'; title: string; recorded_date: string }> };
  missing_information: Array<{ report_id: string; message: string; checked_at: string }>;
  reports_truncated: boolean;
};

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
      <label className="checkbox-field"><input type="checkbox" checked={review} onChange={event => setReview(event.target.checked)} />Allow checking and confirming records</label><p className="muted">Reading is included. This invitation grants access in Funkyfarm; it does not establish an official authority mandate.</p><Button type="submit" loading={busy}>Create private invitation</Button>
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

function FarmDirectory({ workspace, search, selected, disabled, choose }: {
  workspace: Session['workspace']; search: string; selected: Selection | null; disabled: boolean; choose: (selection: Selection) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page<RecordItem<Farm>> | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => { setOffset(0); }, [search]);
  useEffect(() => {
    let active = true; setPage(null); setError('');
    const query = new URLSearchParams({ workspace_id: workspace.id, search, limit: '25', offset: String(offset) });
    api.get<Page<RecordItem<Farm>>>(`/adviser/farms?${query}`).then(value => { if (active) setPage(value); })
      .catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [workspace.id, search, offset, retry]);
  return <section className="adviser-client">
    <div className="section-heading"><h3>{workspace.name}</h3>{page && <span className="badge">{page.total} {page.total === 1 ? 'farm' : 'farms'}</span>}</div>
    {error ? <Notice kind="error">{error}<Button variant="ghost" onClick={() => setRetry(value => value + 1)}>Reload these farms</Button></Notice>
      : !page ? <p role="status">Opening permitted farms…</p>
        : !page.items.length ? <p>{search ? 'No matching farms in this workspace.' : 'No farms on this page.'}</p>
          : <ul className="record-list">{page.items.map(farm => {
            const chosen = selected?.workspaceId === workspace.id && selected.farmId === farm.id;
            return <li key={farm.id}><div className="record-main"><strong>{farm.data.name ?? 'Farm'}</strong><p>{farm.data.country}{farm.data.region ? ` · ${farm.data.region}` : ''} · {workspace.role === 'owner' || workspace.permissions?.includes('review') ? 'Read & review' : 'Read only'}</p></div>
              <Button variant={chosen ? 'secondary' : 'ghost'} disabled={disabled} aria-expanded={chosen} aria-controls={chosen ? 'adviser-selected-farm' : undefined} onClick={() => choose({ workspaceId: workspace.id, farmId: farm.id })}>Open farm · {farm.data.name ?? 'Farm'}</Button></li>;
          })}</ul>}
    {page && (page.total > 25 || offset > 0) && <div className="actions" aria-label={`Farm pages for ${workspace.name}`}><Button variant="secondary" disabled={!offset || disabled} onClick={() => setOffset(value => Math.max(0, value - 25))}>Previous farms</Button><span>{page.items.length ? `${offset + 1} to ${offset + page.items.length} of ${page.total}` : 'No farms on this page'}</span><Button variant="secondary" disabled={disabled || offset + page.items.length >= page.total} onClick={() => setOffset(value => value + 25)}>Next farms</Button></div>}
  </section>;
}

function RecordPages({ page, label, change }: { page: Page<unknown>; label: string; change: (offset: number) => void }) {
  return page.total > page.limit || page.offset > 0 ? <div className="actions" aria-label={`${label} pages`}>
    <Button variant="secondary" disabled={!page.offset} onClick={() => change(Math.max(0, page.offset - page.limit))}>Previous {label}</Button>
    <span>{page.items.length ? `${page.offset + 1} to ${page.offset + page.items.length} of ${page.total}` : 'No records on this page'}</span>
    <Button variant="secondary" disabled={page.offset + page.items.length >= page.total} onClick={() => change(page.offset + page.limit)}>Next {label}</Button>
  </div> : null;
}

function SelectedFarm({ selection, close, open, question, reloadVersion, busy }: {
  selection: Selection; close: () => void; open: (workspaceId: string, path: string) => Promise<void>;
  question: (detail: FarmDetail) => void; reloadVersion: number; busy: boolean;
}) {
  const [data, setData] = useState<FarmDetail | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [offsets, setOffsets] = useState({ tasks: 0, requests: 0, cases: 0 });
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true; setData(null); setError('');
    const query = new URLSearchParams({ workspace_id: selection.workspaceId, limit: '25', tasks_offset: String(offsets.tasks), requests_offset: String(offsets.requests), cases_offset: String(offsets.cases) });
    api.get<FarmDetail>(`/adviser/farms/${selection.farmId}?${query}`).then(value => { if (active) setData(value); })
      .catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [selection.workspaceId, selection.farmId, offsets, retry, reloadVersion]);
  useEffect(() => { detailRef.current?.focus({ preventScroll: true }); detailRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }, [selection.farmId]);
  const canReview = data?.workspace.role === 'owner' || data?.workspace.permissions?.includes('review') === true;
  const go = (path: string) => void open(selection.workspaceId, path);
  const statusLabel = (status: string) => (({ draft: 'Needs preparation', ready_to_send: 'Prepared for manual sending', sent: 'Sending recorded', receipt_saved: 'Receipt saved', accepted_recorded: 'Acceptance recorded', needs_changes: 'Changes requested', cancelled: 'Set aside' } as Record<string, string>)[status] ?? status.replaceAll('_', ' '));
  return <section ref={detailRef} tabIndex={-1} id="adviser-selected-farm" className="panel adviser-selected" aria-label={data ? `Selected farm · ${data.farm.data.name ?? 'Farm'}` : 'Selected farm'}>
    <div className="section-heading"><h2>{data?.farm.data.name ?? 'Farm details'}</h2><Button variant="ghost" onClick={close}>Close farm</Button></div>
    {error ? <Notice kind="error">{error}<Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Reload this farm</Button></Notice> : !data ? <p role="status">Checking this farm’s current access and records…</p> : <>
      <p>{canReview ? 'You can read and check this farm’s records. Changes still need a separate approval.' : 'Read only. You can see the records, but cannot change or approve them.'}</p>
      <div className="actions"><Button disabled={busy} onClick={() => go(`/app/fields/${data.farm.id}/check`)}>Check parcels</Button><Button variant="secondary" disabled={busy} onClick={() => go(`/app/farm/${data.farm.id}`)}>Open farm records</Button>{canReview && <Button variant="ghost" disabled={busy} onClick={() => question(data)}>Ask this farmer</Button>}</div>
      <div className="adviser-summary" aria-label="Farm follow-up summary">
        <div className={data.schedule.overdue ? 'is-urgent' : ''}><strong>{data.schedule.overdue}</strong><span>Past recorded date</span></div>
        <div><strong>{data.schedule.upcoming}</strong><span>Due in the next 30 days</span></div>
        <div><strong>{Object.values(data.review_counts).reduce((sum, count) => sum + count, 0)}</strong><span>Records to check</span></div>
        <div><strong>{data.schedule.undated}</strong><span>No date recorded</span></div>
      </div>
      <p className="muted">Dates are from saved tasks and paperwork, not a new legal deadline. Date check: {data.schedule.today} (UTC).</p>
      <section className="adviser-next"><h3>What needs attention first</h3>{data.schedule.items.length ? <ol>{data.schedule.items.map(item => <li key={item.id}>
        <div><strong>{item.title}</strong><span className={item.recorded_date < data.schedule.today ? 'adviser-date is-urgent' : 'adviser-date'}>{item.recorded_date < data.schedule.today ? 'Past recorded date' : item.recorded_date === data.schedule.today ? 'Recorded date is today' : 'Recorded date'} · {item.recorded_date}</span></div>
        <Button variant="ghost" disabled={busy} onClick={() => go(item.kind === 'tasks' ? `/app/tasks/${item.id}` : item.kind === 'requests' ? `/app/paperwork/${item.id}` : `/app/cases/${item.id}`)}>Open item</Button>
      </li>)}</ol> : <p>No upcoming dates are saved. Check the undated work below.</p>}</section>
      <section className="adviser-reviews"><h3>Records waiting for a check</h3><p>{data.review_counts.facts} farm answers · {data.review_counts.operations} work records · {data.review_counts.purchases} purchases · {data.review_counts.sales} sales</p><div className="actions"><Button variant="secondary" disabled={busy} onClick={() => go(`/app/fields/${data.farm.id}#facts`)}>Check farm answers</Button><Button variant="secondary" disabled={busy} onClick={() => go(`/app/record-work?farm_id=${data.farm.id}&review=1`)}>Check notebook records</Button></div></section>
      <h3>Corrections and inspections</h3>{data.admin_cases.items.length ? <ul className="record-list">{data.admin_cases.items.map(item => <li key={item.id}><div className="record-main"><strong>{item.data.title}</strong><p>{statusLabel(item.data.status)} · {item.data.reporting_year}{item.data.deadline ? ` · Recorded date ${item.data.deadline}` : ''}</p></div><Button variant="secondary" disabled={busy} onClick={() => go(`/app/cases/${item.id}${item.data.job_type === 'correction' ? '/correction' : ''}`)}>Open {item.data.job_type === 'correction' ? 'correction' : item.data.job_type === 'inspection' ? 'inspection' : 'parcel case'} · {item.data.title}</Button></li>)}</ul> : <p>No cases on this page.</p>}
      <RecordPages page={data.admin_cases} label="cases" change={offset => setOffsets(previous => ({ ...previous, cases: offset }))}/>
      <p className="muted">{data.admin_cases.total} cases for this farm · {data.case_counts.draft ?? 0} drafts · {data.case_counts.needs_changes ?? 0} with changes requested.</p><Button variant="ghost" disabled={busy} onClick={() => go(`/app/cases?farm_id=${data.farm.id}`)}>All cases for this farm</Button>
      <section className="adviser-follow-up" aria-label="Paperwork and questions"><h3>Paperwork</h3>{data.requests.items.length ? <ul className="record-list">{data.requests.items.map(request => <li key={request.id}><div><strong>{request.data.title}</strong><p>{request.data.deadline ? `Recorded date ${request.data.deadline}` : 'No deadline recorded'} · {statusLabel(request.data.status)}</p></div><Button variant="ghost" disabled={busy} onClick={() => go(`/app/paperwork/${request.id}`)}>Open paperwork</Button></li>)}</ul> : <p>No paperwork on this page.</p>}
        <RecordPages page={data.requests} label="paperwork" change={offset => setOffsets(previous => ({ ...previous, requests: offset }))}/>
        <h3>Farmer questions and follow-up</h3>{data.tasks.items.length ? <ul className="record-list">{data.tasks.items.map(task => <li key={task.id}><div><strong>{task.data.title}</strong>{task.data.description && <p>{task.data.description}</p>}{task.data.notes && <p>Saved answer: {task.data.notes}</p>}<p>{statusLabel(task.data.status)}{task.data.due_date ? ` · Due ${task.data.due_date}` : ''}</p></div><Button variant="ghost" disabled={busy} onClick={() => go(`/app/tasks/${task.id}`)}>Open question and answer</Button></li>)}</ul> : <p>No questions on this page.</p>}
        <RecordPages page={data.tasks} label="questions" change={offset => setOffsets(previous => ({ ...previous, tasks: offset }))}/>
        <Button variant="ghost" disabled={busy} onClick={() => go(`/app/tasks?farm_id=${data.farm.id}`)}>Questions and answers</Button>
        {data.missing_information.length > 0 && <><h3>Missing details in saved drafts</h3>{data.missing_information.map((item, index) => <p key={`${item.report_id}-${index}`}>{item.message}<Button variant="ghost" disabled={busy} onClick={() => go(`/app/reports/${item.report_id}`)}>Review current response</Button></p>)}</>}
        {data.reports_truncated && <p>More saved forms are available. Open the farm’s records to check the remaining forms.</p>}
      </section>
    </>}
  </section>;
}

export function AdviserPage() {
  const { session, switchWorkspace, refresh } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const farms = useRecords<Farm>('farms');
  const requests = useRecords<Request>('requests');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [questionFarm, setQuestionFarm] = useState<RecordItem<Farm> | null>(null);
  const [panel, setPanel] = useState<'question' | 'accept' | 'invite' | null>(null);
  const [invitationCode, setInvitationCode] = useState('');
  const [accepted, setAccepted] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);
  const actionRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const owner = session?.workspace.role === 'owner';
  const canReview = owner || session?.workspace.permissions?.includes('review') === true;
  const scope = JSON.stringify([session?.workspace.id, session?.workspace.role, session?.workspace.permissions, session?.workspace.farm_ids]);
  async function load() {
    const attempt = ++generation.current; setLoading(true); setError('');
    try { const result = await api.get<Overview>(`/adviser/clients?limit=20&offset=${offset}`); if (attempt === generation.current) setOverview(result); }
    catch (failure) { if (attempt === generation.current) { setOverview(null); setError(errorMessage(failure)); } }
    finally { if (attempt === generation.current) setLoading(false); }
  }
  useEffect(() => { const timer = window.setTimeout(() => setSubmittedSearch(search.trim()), 250); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => {
    setOverview(null); setSelection(null); setPanel(null); setQuestionFarm(null); setInvitationCode(''); setAccepted(''); void load();
    return () => { generation.current += 1; };
  }, [scope, offset]);
  useEffect(() => {
    const farmId = params.get('farm');
    if (farmId && session && /^[0-9a-f-]{36}$/i.test(farmId)) setSelection({ workspaceId: session.workspace.id, farmId });
  }, [params, scope]);
  useEffect(() => {
    if (!panel) return;
    actionRef.current?.focus({ preventScroll: true }); actionRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [panel]);
  async function open(workspaceId: string, path: string) {
    setBusy(true); setError('');
    try { await switchWorkspace(workspaceId); navigate(path); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function accept(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setAccepted('');
    try { await api.post('/invitations/accept', { token: invitationCode.trim() }); setInvitationCode(''); await refresh(); await load(); setReloadVersion(value => value + 1); setAccepted('Invitation accepted. The farm workspace is now available in your workspace selector. Your own records remain separate.'); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  function ask(data: FarmDetail) {
    if (data.workspace.id !== session?.workspace.id) { void open(data.workspace.id, `/app/adviser?farm=${data.farm.id}&ask=1`); return; }
    setQuestionFarm(data.farm); setPanel('question');
  }
  useEffect(() => {
    if (params.get('ask') !== '1' || !selection || !canReview || selection.workspaceId !== session?.workspace.id) return;
    const farm = farms.items.find(item => item.id === selection.farmId);
    if (farm) { setQuestionFarm(farm); setPanel('question'); }
  }, [selection, farms.items, params, canReview, scope]);
  return <>
    <PageHeader title="Adviser desk" description="Choose a farm, see what is missing and help with its next task." />
    {error && <Notice kind="error">{error}<Button variant="ghost" onClick={() => void load()}>Retry</Button></Notice>}{accepted && <Notice kind="success">{accepted}</Notice>}
    <section className="panel"><div className="section-heading"><h2>Farms on your desk</h2><span className="badge">{overview?.total ?? '…'} workspaces</span></div>
      <Field label="Search farms or clients"><input type="search" maxLength={160} value={search} onChange={event => setSearch(event.target.value)} placeholder="Farm name, country or region" /></Field>
      {loading ? <p role="status">Checking your current farm permissions…</p> : !overview?.items.length ? <p>Your first farm starts with permission. Accept a farmer’s private invitation to add their workspace.</p> : overview.items.map(workspace => <FarmDirectory key={`${scope}/${workspace.id}/${reloadVersion}`} workspace={workspace} search={workspace.name.toLocaleLowerCase().includes(submittedSearch.toLocaleLowerCase()) ? '' : submittedSearch} selected={selection} disabled={busy} choose={value => { setSelection(value); setPanel(null); setQuestionFarm(null); }}/>)}
      {overview && (overview.total > overview.limit || offset > 0) && <div className="actions"><Button variant="ghost" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous workspaces</Button><span>{offset + 1} to {Math.min(offset + overview.limit, overview.total)} of {overview.total}</span><Button variant="ghost" disabled={offset + overview.limit >= overview.total || loading} onClick={() => setOffset(value => value + 20)}>Next workspaces</Button></div>}
      <p className="muted">Search includes every permitted farm in the displayed workspaces. Use workspace pages to see other clients.</p><p className="muted">{overview?.mandate_notice ?? 'Farm access here does not establish an official authority mandate.'}</p>
    </section>
    {selection && <SelectedFarm key={`${scope}/${selection.workspaceId}/${selection.farmId}`} selection={selection} close={() => { setSelection(null); setPanel(null); setQuestionFarm(null); }} open={open} question={ask} reloadVersion={reloadVersion} busy={busy}/>}
    <div className="actions"><Button variant="secondary" aria-expanded={panel === 'accept'} onClick={() => setPanel(panel === 'accept' ? null : 'accept')}>Accept a farmer’s invitation</Button>{owner && <Button variant="ghost" aria-expanded={panel === 'invite'} onClick={() => setPanel(panel === 'invite' ? null : 'invite')}>Give an adviser access</Button>}</div>
    {panel && <div ref={actionRef} tabIndex={-1} className="panel" aria-label={panel === 'question' ? 'Question for selected farm' : panel === 'accept' ? 'Accept invitation form' : 'Adviser invitation form'}><Button variant="ghost" onClick={() => setPanel(null)}>Close form</Button>
      {panel === 'question' && questionFarm && canReview && <><p>Question for {questionFarm.data.name ?? 'this farm'}.</p>{requests.error ? <Notice kind="error">{requests.error}</Notice> : requests.loading ? <p role="status">Loading this farm’s paperwork…</p> : <FarmerQuestion key={`${scope}/${questionFarm.id}`} farmId={questionFarm.id} farms={[questionFarm]} requests={requests.items} onSaved={async () => { await requests.reload(); setReloadVersion(value => value + 1); }}/>}</>}
      {panel === 'accept' && <section><h2>Accept a farmer’s invitation</h2><p>Use the private code addressed to your signed-in email. Acceptance adds only the access the farmer chose.</p><form className="stack" onSubmit={accept}><Field label="Private invitation code"><input required type="password" autoComplete="off" value={invitationCode} onChange={event => setInvitationCode(event.target.value)} /></Field><Button type="submit" loading={busy}>Accept invitation</Button></form></section>}
      {panel === 'invite' && owner && (farms.error ? <Notice kind="error">{farms.error}</Notice> : farms.loading ? <p role="status">Loading permitted farms…</p> : <Delegation key={scope} farms={farms.items} />)}
    </div>}
  </>;
}
