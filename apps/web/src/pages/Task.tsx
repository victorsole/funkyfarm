import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { usePrivateDraft } from '../offline';
import type { Page, RecordItem, Session } from '../types';

type TaskData = {
  farm_id: string; title: string; description?: string; notes?: string;
  status: 'open' | 'in_progress' | 'done' | 'cancelled'; due_date?: string;
  purpose?: string; asked_by?: string; asked_at?: string;
  document_id?: string; request_id?: string; checklist_id?: string;
};
type Task = RecordItem<TaskData>;
const statuses = { open: 'Not started', in_progress: 'Working on it', done: 'Done', cancelled: 'No longer needed' };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const binding = (session: Session) => JSON.stringify([session.user.id, session.workspace.id, session.workspace.role, session.workspace.permissions, session.workspace.farm_ids]);
const allowedFarm = (session: Session, farmId: string) => uuid.test(farmId) && (session.workspace.farm_ids == null || session.workspace.farm_ids.includes(farmId));
function checkedTask(value: Task, session: Session, id?: string): Task {
  if (value?.data && value.data.status == null) value = { ...value, data: { ...value.data, status: 'open' } };
  if (!value || value.kind !== 'tasks' || !uuid.test(value.id) || id && value.id !== id
    || value.workspace_id !== session.workspace.id || !value.data || !allowedFarm(session, value.data.farm_id)
    || !Number.isInteger(value.revision) || value.revision < 1 || typeof value.data.title !== 'string'
    || !Object.hasOwn(statuses, value.data.status)
    || ['description', 'notes', 'due_date', 'purpose', 'asked_by', 'asked_at', 'document_id', 'request_id'].some(key => {
      const item = (value.data as Record<string, unknown>)[key];
      return item != null && typeof item !== 'string';
    })) throw new Error('This task does not match your current farm access. Open it again.');
  return value;
}
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  return (await api.downloadResponse(path, { signal })).json() as Promise<T>;
}

export function TasksPage() {
  const { session } = useSession();
  const [query] = useSearchParams();
  const farmId = query.get('farm_id') || '';
  return session ? <TaskList key={`${binding(session)}:${farmId}`} session={session} farmId={farmId} /> : null;
}

function TaskList({ session, farmId }: { session: Session; farmId: string }) {
  const [offset, setOffset] = useState(0);
  const [activeOnly, setActiveOnly] = useState(true);
  const [page, setPage] = useState<Page<Task> | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setPage(null); setError('');
    if (farmId && !allowedFarm(session, farmId)) { setError('This farm is not available through your current access.'); return () => controller.abort(); }
    const params = new URLSearchParams({ limit: '25', offset: String(offset), task_state: activeOnly ? 'active' : 'all' });
    if (farmId) params.set('farm_id', farmId);
    read<Page<Task>>(`/tasks?${params}`, controller.signal).then(value => {
      if (!Array.isArray(value.items) || !Number.isInteger(value.total) || value.total < 0 || value.items.length > 25) throw new Error('The task list could not be read. Try again.');
      const items = value.items.map(item => { const checked = checkedTask(item, session); if (farmId && checked.data.farm_id !== farmId) throw new Error('The returned task belongs to another farm.'); return checked; });
      if (active) setPage({ ...value, items });
    }).catch(failure => { if (active && !controller.signal.aborted) setError(errorMessage(failure)); });
    return () => { active = false; controller.abort(); };
  }, [session, farmId, offset, activeOnly, attempt]);
  return <>
    <PageHeader title="Tasks and questions" description="Read what is needed, save your answer and keep track of the next step." />
    <p><Link to={farmId ? `/app/fields/${farmId}` : '/app/home'}>{farmId ? 'Back to this farm' : 'Back to home'}</Link></p>
    <section className="panel">
      <label className="checkbox-field"><input type="checkbox" checked={activeOnly} onChange={event => { setActiveOnly(event.target.checked); setOffset(0); }} />Show only unfinished tasks</label>
      {error ? <Notice kind="error">{error}<Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Try again</Button></Notice>
        : !page ? <p role="status">Opening your tasks…</p>
          : <>
            {!page.total ? <p>{activeOnly ? 'No unfinished tasks. Show all tasks to read saved answers and completed work.' : 'No tasks are saved here yet.'}</p> : !page.items.length ? <p>No tasks remain on this page. Go back to the previous page.</p>
              : <ul className="record-list">{page.items.map(task => <li key={task.id}><Link to={`/app/tasks/${task.id}`}><div className="record-main"><strong>{task.data.title}</strong><p>{task.data.purpose === 'missing_information' ? 'Question from your adviser' : 'Farm task'}{task.data.due_date ? ` · Needed by ${task.data.due_date}` : ''}</p><span>{statuses[task.data.status]}</span>{task.data.notes && <p>Answer or note saved</p>}</div></Link></li>)}</ul>}
            <div className="actions" aria-label="Task pages"><Button variant="secondary" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 25))}>Previous page</Button><span>{page.items.length ? `${offset + 1} to ${offset + page.items.length} of ${page.total} ${activeOnly ? 'unfinished' : 'saved'} tasks` : `${page.total} ${activeOnly ? 'unfinished' : 'saved'} tasks`}</span><Button variant="secondary" disabled={offset + page.items.length >= page.total || !page.items.length} onClick={() => setOffset(value => value + 25)}>Next page</Button></div>
          </>}
    </section>
  </>;
}

export function TaskPage() {
  const { id = '' } = useParams(); const { session } = useSession();
  return session ? <TaskDetail key={`${binding(session)}:${id}`} session={session} id={id} /> : null;
}

function TaskDetail({ session, id }: { session: Session; id: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const [farm, setFarm] = useState<RecordItem | null>(null);
  const [links, setLinks] = useState<{ document?: string; request?: string }>({});
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setTask(null); setFarm(null); setLinks({}); setError('');
    if (!uuid.test(id)) { setError('This task link is not valid. Open the task from your task list.'); return () => controller.abort(); }
    void (async () => {
      const current = checkedTask(await read<Task>(`/tasks/${id}`, controller.signal), session, id);
      const currentFarm = await read<RecordItem>(`/farms/${current.data.farm_id}`, controller.signal);
      if (currentFarm.id !== current.data.farm_id || currentFarm.kind !== 'farms' || currentFarm.workspace_id !== session.workspace.id) throw new Error('The task’s farm could not be verified.');
      if (!active) return;
      setTask(current); setFarm(currentFarm);
      const found: { document?: string; request?: string } = {};
      for (const [field, kind, path, key] of [['document_id', 'documents', 'documents', 'document'], ['request_id', 'requests', 'paperwork', 'request']] as const) {
        const linkedId = current.data[field];
        if (!linkedId || !uuid.test(linkedId)) continue;
        try {
          const record = await read<RecordItem>(`/${kind}/${linkedId}`, controller.signal);
          if (record.kind === kind && record.id === linkedId && record.workspace_id === session.workspace.id && record.data.farm_id === current.data.farm_id) found[key] = `/app/${path}/${linkedId}`;
        } catch (failure) { if (controller.signal.aborted) return; if (active) setNotice(`A linked document or request is unavailable: ${errorMessage(failure)}`); }
      }
      if (active) setLinks(found);
    })().catch(failure => { if (active && !controller.signal.aborted) setError(errorMessage(failure)); });
    return () => { active = false; controller.abort(); };
  }, [id, session, attempt]);
  return <>
    <PageHeader title={task?.data.title || 'Task'} description={farm ? `For ${String(farm.data.name || 'this farm')}` : 'Read the question and save your answer here.'} />
    <p><Link to={`/app/tasks${task ? `?farm_id=${task.data.farm_id}` : ''}`}>Back to tasks</Link></p>
    {error && <Notice kind="error">{error}<Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Open the task again</Button></Notice>}
    {notice && <Notice kind="warning">{notice}</Notice>}
    {!task && !error && <p role="status">Opening the task and checking your farm access…</p>}
    {task && farm && <>
      <section className="panel"><h2>{task.data.purpose === 'missing_information' ? 'What your adviser needs' : 'What needs doing'}</h2><p style={{ whiteSpace: 'pre-wrap' }}>{task.data.description || task.data.title}</p>{task.data.asked_at && <p className="muted">Asked {new Date(task.data.asked_at).toLocaleDateString()}</p>}{task.data.due_date && <p>Needed by <strong>{task.data.due_date}</strong></p>}<p>Status: {statuses[task.data.status]}</p><div className="actions">{links.document && <Link to={links.document}>Read the original document</Link>}{links.request && <Link to={links.request}>Open the related paperwork</Link>}<Link to={`/app/documents?farm_id=${task.data.farm_id}`}>Add or find a farm document</Link></div><p className="muted">Adding a file to Documents does not attach it to this answer. Mention its exact name below so your adviser can find it in this farm.</p></section>
      <TaskAnswer task={task} session={session} onSaved={value => { if (mounted.current) { setTask(value); setNotice('Your answer and task status are saved. People with access to this farm can read them here. No external message was sent.'); } }} onReload={() => setAttempt(value => value + 1)} />
    </>}
  </>;
}

function TaskAnswer({ task, session, onSaved, onReload }: { task: Task; session: Session; onSaved: (value: Task) => void; onReload: () => void }) {
  const draft = usePrivateDraft(`tasks/${task.data.farm_id}/${task.id}/answer`, { revision: task.revision, notes: task.data.notes || '', status: task.data.status });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const canWrite = allowedFarm(session, task.data.farm_id) && (session.workspace.role === 'owner' || session.workspace.permissions?.includes('review') === true);
  const stale = draft.value.revision !== task.revision;
  const question = task.data.purpose === 'missing_information' || !!task.data.asked_by;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || busy || !draft.ready || stale || draft.saving) return;
    const value = draft.value;
    if (!Object.hasOwn(statuses, value.status) || typeof value.notes !== 'string' || value.notes.length > 4000) { setError('Choose a status and keep your answer within 4,000 characters.'); return; }
    if (question && ['done', 'cancelled'].includes(value.status) && !value.notes.trim()) { setError(value.status === 'cancelled' ? 'Explain why this question is no longer needed before closing it.' : 'Write an answer before marking this question as done.'); return; }
    setBusy(true); setError('');
    try {
      const saved = checkedTask(await api.patch<Task>(`/tasks/${task.id}`, { expected_revision: task.revision, data: { notes: value.notes, status: value.status } }), session, task.id);
      if (saved.data.farm_id !== task.data.farm_id) throw new Error('The saved answer does not match this farm. Open the task again.');
      if (!active.current) return;
      draft.setValue({ revision: saved.revision, notes: saved.data.notes || '', status: saved.data.status }); onSaved(saved);
    } catch (failure) {
      if (active.current) setError(failure instanceof ApiError && failure.status === 409 ? 'This task changed while you were answering. Your draft is still here. Read the latest task before deciding which answer to keep.' : errorMessage(failure));
    } finally { if (active.current) setBusy(false); }
  }
  return <section className="panel"><h2>{question ? 'Your answer' : 'Your note and progress'}</h2>
    {!canWrite && <Notice>You can read this task and its saved answer. Ask the farm owner for permission to reply or change its status.</Notice>}
    {task.data.notes && <div className="panel inset"><h3>Saved answer or note</h3><p style={{ whiteSpace: 'pre-wrap' }}>{task.data.notes}</p></div>}
    {error && <Notice kind="error">{error}<Button variant="secondary" disabled={busy} onClick={onReload}>Read the latest task</Button></Notice>}
    {canWrite && (!draft.ready ? <p role="status">Opening your private answer draft…</p> : <>
      {draft.error && <Notice kind="warning">{draft.error}</Notice>}
      {question && draft.value.status === 'cancelled' && <p>Explain in your answer why this question is no longer needed. Your adviser can read the reason here.</p>}
      {stale && <Notice kind="warning"><p>Your private draft was written for an older version. Compare the question and saved answer above before continuing.</p><Button variant="secondary" disabled={busy} onClick={() => draft.setValue(value => ({ ...value, revision: task.revision }))}>Keep my draft after reading this version</Button><Button variant="ghost" disabled={busy} onClick={() => draft.setValue({ revision: task.revision, notes: task.data.notes || '', status: task.data.status })}>Use the saved answer instead</Button></Notice>}
      <form className="stack" onSubmit={save}><Field label={question ? 'What would you like to tell your adviser?' : 'What has been done, or what is still needed?'}><textarea rows={5} maxLength={4000} value={draft.value.notes} disabled={busy || stale} onChange={event => draft.setValue(value => ({ ...value, notes: event.target.value }))} /></Field><Field label="Task progress"><select value={draft.value.status} disabled={busy || stale} onChange={event => draft.setValue(value => ({ ...value, status: event.target.value as TaskData['status'] }))}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><p className="muted">This answer is a note for the people helping your farm. Saving it does not confirm farm facts, complete a legal requirement or send paperwork to an authority.</p><p className="muted" role="status">{draft.saving ? 'Saving your private draft on this device…' : 'Your unfinished answer stays privately on this device until you save it below.'}</p><Button type="submit" loading={busy} disabled={stale || draft.saving}>Save answer and progress</Button></form>
    </>)}
  </section>;
}
