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
  evidence_documents?: TaskEvidence[];
};
type TaskEvidence = { document_id: string; document_revision: number };
type Task = RecordItem<TaskData>;
const statuses = { open: 'Not started', in_progress: 'Working on it', done: 'Done', cancelled: 'No longer needed' };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const binding = (session: Session) => JSON.stringify([session.user.id, session.workspace.id, session.workspace.role, session.workspace.permissions, session.workspace.farm_ids]);
const allowedFarm = (session: Session, farmId: string) => uuid.test(farmId) && (session.workspace.farm_ids == null || session.workspace.farm_ids.includes(farmId));
const validEvidence = (value: unknown): value is TaskEvidence[] => Array.isArray(value) && value.length <= 20 && value.every(item => item && typeof item === 'object' && Object.keys(item).length === 2 && uuid.test(item.document_id) && Number.isInteger(item.document_revision) && item.document_revision > 0) && new Set(value.map(item => item.document_id)).size === value.length;
const documentName = (item: RecordItem) => String(item.data.title || item.data.filename || 'Farm document');
function checkedDocument(item: RecordItem, session: Session, farmId: string): RecordItem {
  if (!item || item.kind !== 'documents' || !uuid.test(item.id) || item.workspace_id !== session.workspace.id || item.data?.farm_id !== farmId || !Number.isInteger(item.revision) || item.revision < 1) throw new Error('This document does not belong to this farm. Refresh the document list.');
  return item;
}
function checkedTask(value: Task, session: Session, id?: string): Task {
  if (value?.data && value.data.status == null) value = { ...value, data: { ...value.data, status: 'open' } };
  if (!value || value.kind !== 'tasks' || !uuid.test(value.id) || id && value.id !== id
    || value.workspace_id !== session.workspace.id || !value.data || !allowedFarm(session, value.data.farm_id)
    || !Number.isInteger(value.revision) || value.revision < 1 || typeof value.data.title !== 'string'
    || !Object.hasOwn(statuses, value.data.status)
    || value.data.evidence_documents != null && !validEvidence(value.data.evidence_documents)
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
      <section className="panel"><h2>{task.data.purpose === 'missing_information' ? 'What your adviser needs' : 'What needs doing'}</h2><p style={{ whiteSpace: 'pre-wrap' }}>{task.data.description || task.data.title}</p>{task.data.asked_at && <p className="muted">Asked {new Date(task.data.asked_at).toLocaleDateString()}</p>}{task.data.due_date && <p>Needed by <strong>{task.data.due_date}</strong></p>}<p>Status: {statuses[task.data.status]}</p><div className="actions">{links.document && <Link to={links.document}>Read the original document</Link>}{links.request && <Link to={links.request}>Open the related paperwork</Link>}</div></section>
      <TaskAnswer task={task} session={session} onSaved={value => { if (mounted.current) { setTask(value); setNotice('Your answer and task status are saved for the people helping this farm.'); } }} onReload={() => setAttempt(value => value + 1)} />
    </>}
  </>;
}

function TaskAnswer({ task, session, onSaved, onReload }: { task: Task; session: Session; onSaved: (value: Task) => void; onReload: () => void }) {
  const draft = usePrivateDraft(`tasks/${task.data.farm_id}/${task.id}/answer`, { revision: task.revision, notes: task.data.notes || '', status: task.data.status, evidence_documents: task.data.evidence_documents || [] });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [documents, setDocuments] = useState<Record<string, RecordItem>>({});
  const [documentPage, setDocumentPage] = useState<Page<RecordItem> | null>(null);
  const [documentError, setDocumentError] = useState('');
  const [search, setSearch] = useState(''); const [offset, setOffset] = useState(0); const [refresh, setRefresh] = useState(0);
  const [file, setFile] = useState<File | null>(null); const [uploadNotice, setUploadNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const canWrite = allowedFarm(session, task.data.farm_id) && (session.workspace.role === 'owner' || session.workspace.permissions?.includes('review') === true);
  const stale = draft.value.revision !== task.revision;
  const question = task.data.purpose === 'missing_information' || !!task.data.asked_by;
  const evidence = draft.value.evidence_documents ?? task.data.evidence_documents ?? [];
  useEffect(() => {
    const controller = new AbortController(); let current = true;
    setDocumentPage(null); setDocumentError('');
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ farm_id: task.data.farm_id, limit: '25', offset: String(offset), q: search });
      read<Page<RecordItem>>(`/documents?${params}`, controller.signal).then(page => {
        if (!Array.isArray(page.items) || page.items.length > 25 || !Number.isInteger(page.total) || page.total < 0) throw new Error('The document list could not be read. Refresh it to try again.');
        const items = page.items.map(item => checkedDocument(item, session, task.data.farm_id));
        if (current) { setDocumentPage({ ...page, items }); setDocuments(previous => ({ ...previous, ...Object.fromEntries(items.map(item => [item.id, item])) })); }
      }).catch(failure => { if (current && !controller.signal.aborted) setDocumentError(errorMessage(failure)); });
    }, search ? 250 : 0);
    return () => { current = false; controller.abort(); window.clearTimeout(timer); };
  }, [task.data.farm_id, session, search, offset, refresh]);
  useEffect(() => {
    const controller = new AbortController(); let current = true;
    void Promise.all((task.data.evidence_documents || []).map(async source => {
      try { return checkedDocument(await read<RecordItem>(`/documents/${source.document_id}`, controller.signal), session, task.data.farm_id); }
      catch (failure) { if (current && !controller.signal.aborted) setDocumentError(`A saved supporting document could not be opened. ${errorMessage(failure)}`); return null; }
    })).then(items => { if (current) setDocuments(previous => ({ ...previous, ...Object.fromEntries(items.filter((item): item is RecordItem => item !== null).map(item => [item.id, item])) })); });
    return () => { current = false; controller.abort(); };
  }, [task.data.evidence_documents, task.data.farm_id, session, refresh]);
  function chooseDocument(item: RecordItem, selected: boolean) {
    draft.setValue(value => ({ ...value, evidence_documents: selected ? [...(value.evidence_documents ?? task.data.evidence_documents ?? []).filter(source => source.document_id !== item.id), { document_id: item.id, document_revision: item.revision }] : (value.evidence_documents ?? task.data.evidence_documents ?? []).filter(source => source.document_id !== item.id) }));
  }
  async function uploadEvidence() {
    if (!file || busy || stale || !canWrite || !draft.ready || evidence.length >= 20) return;
    if (!file.size || file.size > 12 * 1024 * 1024) { setError('Choose a non-empty PDF, photo or text file smaller than 12 MiB.'); return; }
    const data = new FormData(); data.append('file', file); data.append('farm_id', task.data.farm_id);
    setBusy(true); setError(''); setUploadNotice('');
    try {
      const saved = checkedDocument(await api.upload<RecordItem>('/documents', data), session, task.data.farm_id);
      if (!active.current) return;
      setDocuments(previous => ({ ...previous, [saved.id]: saved })); chooseDocument(saved, true); setFile(null); setRefresh(value => value + 1);
      if (fileInput.current) fileInput.current.value = '';
      setUploadNotice('The document is saved. Save your answer below to attach it to this task.');
    } catch (failure) { if (active.current) setError(errorMessage(failure)); }
    finally { if (active.current) setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || busy || !draft.ready || stale || draft.saving) return;
    const value = draft.value;
    if (!Object.hasOwn(statuses, value.status) || typeof value.notes !== 'string' || value.notes.length > 4000) { setError('Choose a status and keep your answer within 4,000 characters.'); return; }
    if (!validEvidence(evidence)) { setError('Choose up to 20 supporting documents, once each.'); return; }
    if (question && ['done', 'cancelled'].includes(value.status) && !value.notes.trim()) { setError(value.status === 'cancelled' ? 'Explain why this question is no longer needed before closing it.' : 'Write an answer before marking this question as done.'); return; }
    setBusy(true); setError('');
    try {
      const saved = checkedTask(await api.patch<Task>(`/tasks/${task.id}`, { expected_revision: task.revision, data: { notes: value.notes, status: value.status, evidence_documents: evidence } }), session, task.id);
      if (saved.data.farm_id !== task.data.farm_id) throw new Error('The saved answer does not match this farm. Open the task again.');
      if (!active.current) return;
      draft.setValue({ revision: saved.revision, notes: saved.data.notes || '', status: saved.data.status, evidence_documents: saved.data.evidence_documents || [] }); onSaved(saved);
    } catch (failure) {
      if (active.current) setError(failure instanceof ApiError && failure.status === 409 ? `${errorMessage(failure)} Your draft is still here. Refresh the documents or read the latest task before saving again.` : errorMessage(failure));
    } finally { if (active.current) setBusy(false); }
  }
  return <section className="panel"><h2>{question ? 'Your answer' : 'Your note and progress'}</h2>
    {!canWrite && <Notice>You can read this task and its saved answer. Ask the farm owner for permission to reply or change its status.</Notice>}
    {task.data.notes && <div className="panel inset"><h3>Saved answer or note</h3><p style={{ whiteSpace: 'pre-wrap' }}>{task.data.notes}</p></div>}
    {!!task.data.evidence_documents?.length && <div className="panel inset"><h3>Documents attached to the saved answer</h3><ul>{task.data.evidence_documents.map(source => <li key={source.document_id}>{documents[source.document_id] ? <Link to={`/app/documents/${source.document_id}`}>{documentName(documents[source.document_id])}</Link> : 'Opening supporting document…'}{documents[source.document_id] && documents[source.document_id].revision !== source.document_revision && <span> · Changed since this answer was saved</span>}</li>)}</ul></div>}
    {documentError && <Notice kind="warning">{documentError}<Button variant="secondary" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh documents</Button></Notice>}
    {error && <Notice kind="error">{error}<Button variant="secondary" disabled={busy} onClick={onReload}>Read the latest task</Button></Notice>}
    {canWrite && (!draft.ready ? <p role="status">Opening your private answer draft…</p> : <>
      {draft.error && <Notice kind="warning">{draft.error}</Notice>}
      {question && draft.value.status === 'cancelled' && <p>Explain in your answer why this question is no longer needed. Your adviser can read the reason here.</p>}
      {stale && <Notice kind="warning"><p>Your private draft was written for an older version. Compare the question and saved answer above before continuing.</p><Button variant="secondary" disabled={busy} onClick={() => draft.setValue(value => ({ ...value, revision: task.revision }))}>Keep my draft after reading this version</Button><Button variant="ghost" disabled={busy} onClick={() => draft.setValue({ revision: task.revision, notes: task.data.notes || '', status: task.data.status, evidence_documents: task.data.evidence_documents || [] })}>Use the saved answer instead</Button></Notice>}
      <form className="stack" onSubmit={save}>
        <Field label={question ? 'What would you like to tell your adviser?' : 'What has been done, or what is still needed?'}><textarea rows={5} maxLength={4000} value={draft.value.notes} disabled={busy || stale} onChange={event => draft.setValue(value => ({ ...value, notes: event.target.value }))} /></Field>
        <fieldset disabled={busy || stale}><legend>Supporting documents (optional)</legend>
          <p>Attach a receipt, photo or letter to your answer. The original question stays unchanged.</p>
          <Field label="Add a PDF, photo or text file"><input ref={fileInput} type="file" accept="application/pdf,image/png,image/jpeg,text/plain,.pdf,.png,.jpg,.jpeg,.txt" onChange={event => setFile(event.target.files?.[0] || null)} /></Field>
          <Button type="button" variant="secondary" disabled={!file || evidence.length >= 20} onClick={() => void uploadEvidence()}>Upload and select document</Button>
          {uploadNotice && <p role="status">{uploadNotice}</p>}
          {!!evidence.length && <><h3>Selected for this answer ({evidence.length} of 20)</h3><ul>{evidence.map(source => {
            const item = documents[source.document_id];
            return <li key={source.document_id}><span>{item ? <Link to={`/app/documents/${item.id}`}>{documentName(item)}</Link> : 'Saved document'}</span>{item && item.revision !== source.document_revision && <> <span>Changed since you selected it.</span> <Button type="button" variant="secondary" onClick={() => chooseDocument(item, true)}>Use the current document</Button></>} <Button type="button" variant="ghost" onClick={() => draft.setValue(value => ({ ...value, evidence_documents: (value.evidence_documents ?? task.data.evidence_documents ?? []).filter(entry => entry.document_id !== source.document_id) }))}>Remove from answer</Button></li>;
          })}</ul></>}
          <Field label="Find a document already saved for this farm"><input type="search" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} placeholder="Receipt, letter or file name" /></Field>
          <Button type="button" variant="ghost" onClick={() => setRefresh(value => value + 1)}>Refresh documents</Button>
          {!documentPage ? <p role="status">{documentError ? 'The document list is unavailable. Your answer is still here.' : 'Opening farm documents…'}</p> : <>
            {documentPage.items.length ? <ul className="record-list">{documentPage.items.map(item => {
              const selected = evidence.some(source => source.document_id === item.id);
              return <li key={item.id}><label className="check-row"><input type="checkbox" checked={selected} disabled={!selected && evidence.length >= 20} onChange={event => chooseDocument(item, event.target.checked)} />{documentName(item)}</label><Link to={`/app/documents/${item.id}`}>Read document</Link></li>;
            })}</ul> : <p>No documents match. Upload one above or try another name.</p>}
            {(offset > 0 || documentPage.total > 25) && <div className="actions"><Button type="button" variant="secondary" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 25))}>Previous documents</Button><span>{offset + (documentPage.items.length ? 1 : 0)} to {offset + documentPage.items.length} of {documentPage.total}</span><Button type="button" variant="secondary" disabled={offset + documentPage.items.length >= documentPage.total || !documentPage.items.length} onClick={() => setOffset(value => value + 25)}>More documents</Button></div>}
          </>}
        </fieldset>
        <Field label="Task progress"><select value={draft.value.status} disabled={busy || stale} onChange={event => draft.setValue(value => ({ ...value, status: event.target.value as TaskData['status'] }))}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><p className="muted">People with access to this farm can read the answer and documents you save here.</p><p className="muted" role="status">{draft.saving ? 'Saving your private draft on this device…' : 'Your unfinished answer stays privately on this device until you save it below.'}</p><Button type="submit" loading={busy} disabled={stale || draft.saving}>Save answer and progress</Button>
      </form>
    </>)}
  </section>;
}
