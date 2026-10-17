import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import { CaseDocumentAttachment, NewCorrectionWizard } from './CorrectionWizard';
import type { Page, RecordItem } from '../types';
import { actionLabel, caseJobs, caseStatusLabel, CASE_PACKET_MAX_BYTES, referenceDetailPath, referenceHref, referenceKinds, referenceRoles,
  type CaseAction, type CaseChecks, type CaseData, type CaseEventData, type CaseEventResult, type CaseHandoff,
  type CaseItem, type CaseJob, type CaseReference, type CaseSummary, type ReferenceKind, type ReferenceRole, type ReferenceView } from './case-types';

const pageSize = 25;
const packetPath = /^\/(?:api\/v1\/)?cases\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/packet$/i;
const isPreparedFolder = (href: string) => packetPath.test(href.split('?')[0]);
const cancelledDownload = () => new DOMException('The folder download was cancelled.', 'AbortError');
type FolderTransfer = { href: string; received: number; total: number | null; cancelling?: boolean };
type FolderControls = { transfer?: FolderTransfer | null; onCancel?: () => void };

async function readPreparedFolder(response: Response, signal: AbortSignal, fingerprint: string, onProgress: (received: number, total: number) => void): Promise<Blob> {
  if (response.status !== 200) throw new Error('The complete folder response is incomplete. Download it again.');
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/zip') throw new Error('The workspace did not return a ZIP folder. No file was saved.');
  if (response.headers.get('x-case-review-fingerprint') !== fingerprint) throw new Error('The returned folder does not match the selected saved version. No file was saved.');
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') throw new Error('The folder transfer uses an unsupported encoding. No file was saved.');
  const lengthHeader = response.headers.get('content-length');
  if (!lengthHeader || !/^[1-9]\d*$/.test(lengthHeader)) throw new Error('The folder size is missing or invalid. No file was saved.');
  const total = Number(lengthHeader);
  if (!Number.isSafeInteger(total) || total < 22 || total > CASE_PACKET_MAX_BYTES) throw new Error('The folder size is invalid or exceeds 128 MiB. No file was saved.');
  if (!response.body) throw new Error('A readable folder transfer is unavailable. No file was saved.');
  const reader = response.body.getReader(); const parts: ArrayBuffer[] = []; let received = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    onProgress(0, total);
    while (true) {
      if (signal.aborted) throw cancelledDownload();
      const part = await reader.read();
      if (signal.aborted) throw cancelledDownload();
      if (part.done) break;
      const next = received + part.value.byteLength;
      if (next > total || next > CASE_PACKET_MAX_BYTES) throw new Error('The folder transfer exceeded its declared size. No file was saved.');
      const copy = new Uint8Array(part.value.byteLength); copy.set(part.value); parts.push(copy.buffer);
      received = next; onProgress(received, total);
    }
    if (received !== total) throw new Error('The folder transfer ended before the complete file arrived. No file was saved.');
    return new Blob(parts, { type: 'application/zip' });
  } catch (failure) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) throw cancelledDownload();
    if (failure instanceof TypeError) throw new Error('The folder transfer stopped before it completed. No file was saved. Try downloading it again.');
    throw failure;
  } finally {
    signal.removeEventListener('abort', cancel); reader.releaseLock();
  }
}
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const nameOf = (record: RecordItem) => String(record.data.title || record.data.filename || record.data.label || record.data.name || (record.data.parcels as { name?: string }[] | undefined)?.map(item => item.name).filter(Boolean).join(', ') || record.data.parcel?.name || (record.data.pack_id ? `Report for ${record.data.reporting_year || 'the recorded year'} · saved ${new Date(record.created_at).toLocaleDateString()}` : 'Saved farm record'));
const referenceKey = (reference: CaseReference) => `${reference.kind}/${reference.id}/${reference.role}`;
const internal = (href?: string) => !!href?.startsWith('/app/') && !href.startsWith('//');
const editableCase = (record: RecordItem<CaseData>) => ['draft', 'needs_changes'].includes(record.data.status);
const eventName = (action: CaseEventData['action']) => Object.hasOwn(actionLabel, action) ? actionLabel[action as CaseAction] : ({ created: 'Case created in the workspace', updated: 'Saved case details changed', reviewed: 'Saved sources reviewed, not sent', answers_checked: 'Individual answers checked, not sent', item_added: 'Preparation item added', item_reviewed: 'Item progress reviewed' } as Record<string, string>)[action] || 'Workspace history entry';
function availableActions(status: CaseData['status']): CaseAction[] {
  if (status === 'draft') return ['cancelled'];
  if (status === 'cancelled') return ['reopen'];
  if (status === 'ready_to_send') return ['sent', 'reopen', 'cancelled'];
  if (status === 'needs_changes') return ['reopen', 'cancelled'];
  if (status === 'accepted_recorded') return ['needs_changes', 'reopen', 'cancelled'];
  return ['receipt', 'accepted', 'needs_changes', 'reopen', 'cancelled'];
}
function useClearAcknowledgement(clear: () => void, revision: number) {
  useEffect(() => { clear(); }, [revision]);
}
const sourcePath = (kind: ReferenceKind, farmId: string) => kind === 'field_change_proposals' ? `/farms/${encodeURIComponent(farmId)}/field-proposals` : `/${kind}?farm_id=${encodeURIComponent(farmId)}${kind === 'reports' ? '&view=summary' : ''}`;
const jobTitle = (job: CaseJob) => caseJobs.find(item => item.value === job)?.title || 'Paperwork case';

function usePage<T>(path: string | null, offset: number, refresh = 0) {
  const { session } = useSession();
  const binding = `${session?.workspace.id}/${path}/${offset}/${refresh}`;
  const [state, setState] = useState<{ binding: string; page: Page<T> | null; error: string; loading: boolean }>({ binding: '', page: null, error: '', loading: false });
  useEffect(() => {
    let active = true; setState({ binding, page: null, error: '', loading: !!path });
    if (path) api.get<Page<T>>(`${path}${path.includes('?') ? '&' : '?'}limit=${pageSize}&offset=${offset}`)
      .then(value => { if (active) setState({ binding, page: value, error: '', loading: false }); }).catch(failure => { if (active) setState({ binding, page: null, error: errorMessage(failure), loading: false }); });
    return () => { active = false; };
  }, [binding]);
  return state.binding === binding ? state : { page: null, error: '', loading: !!path };
}

function Pager({ page, offset, setOffset, loading, label }: { page: Page<unknown> | null; offset: number; setOffset: (offset: number) => void; loading: boolean; label: string }) {
  return <div className="actions" aria-label={label}><Button variant="secondary" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous</Button><span>{page ? `${page.items.length ? offset + 1 : 0}–${offset + page.items.length} of ${page.total}` : 'Page unavailable'}</span><Button variant="secondary" disabled={loading || !page || offset + page.items.length >= page.total} onClick={() => setOffset(offset + pageSize)}>Next</Button></div>;
}

function DraftState({ ready, saving, error }: { ready: boolean; saving: boolean; error: string | null }) {
  return <>{!ready && <p role="status">Opening your private draft…</p>}{saving && <p role="status">Saving your private draft on this device…</p>}{error && <Notice kind="warning">{error} Keep this page open until your changes are saved.</Notice>}</>;
}

export function CasesPage() {
  const [params, setParams] = useSearchParams(); const farms = useRecords('farms'); const { session } = useSession();
  const farmId = params.get('farm_id') || ''; const job = params.get('job_type') || '';
  const offset = Math.max(0, Number(params.get('offset')) || 0); const [refresh, setRefresh] = useState(0);
  const query = new URLSearchParams(); if (farmId) query.set('farm_id', farmId); if (job) query.set('job_type', job);
  const list = usePage<RecordItem<CaseSummary>>(`/cases?${query}`, offset, refresh);
  const canWrite = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  const change = (key: string, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); next.delete('offset'); setParams(next); };
  return <><PageHeader title="Work through the paperwork" description="Keep a field check, a correction or an inspection together, from your first note to the response you receive." /><Link to="/app/paperwork">Back to Paperwork</Link>
    <section className="card"><h2>What needs doing?</h2><div className="farm-start-choices">{caseJobs.map(item => <Link className="farm-start-choice" key={item.value} to={`/app/cases/new?${new URLSearchParams({ ...(farmId ? { farm_id: farmId } : {}), job_type: item.value, ...(item.value === 'correction' ? { focused: '1' } : {}) })}`}><span><strong>{item.title}</strong><small>{item.description}</small></span></Link>)}</div>{!canWrite && <p>You can read the cases your farm permissions allow. A farm owner or delegated reviewer must save changes.</p>}</section>
    <section className="paper-section"><h2>Pick up a saved case</h2><div className="form-grid"><Field label="Farm"><select value={farmId} onChange={event => change('farm_id', event.target.value)}><option value="">All permitted farms</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{nameOf(farm)}</option>)}</select></Field><Field label="Type of work"><select value={job} onChange={event => change('job_type', event.target.value)}><option value="">All three jobs</option>{caseJobs.map(item => <option key={item.value} value={item.value}>{item.title}</option>)}</select></Field></div>
      {farms.error && <Notice kind="error">{farms.error}<Button variant="ghost" onClick={() => void farms.reload()}>Retry farms</Button></Notice>}{list.loading && <p role="status">Opening saved cases…</p>}{list.error && <Notice kind="error">{list.error}<Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Retry cases</Button></Notice>}
      {list.page && (list.page.items.length ? <ul className="record-list">{list.page.items.map(record => <li key={record.id}><Link to={`/app/cases/${record.id}`}><div className="record-main"><strong>{record.data.title}</strong><span>{jobTitle(record.data.job_type)} · {record.data.reporting_year}{record.data.deadline ? ` · recorded deadline ${record.data.deadline}` : ''}</span><small>{record.data.counts ? `${record.data.counts.references} selected records · ${record.data.counts.open_items} of ${record.data.counts.items} preparation items still open` : 'Record and item counts are unavailable'}</small></div><span className="badge">{caseStatusLabel[record.data.status]}</span></Link></li>)}</ul> : <p>No saved case is on this page. Start with the job above; no official submission will be made by creating it.</p>)}
      <Pager page={list.page} offset={offset} setOffset={value => { const next = new URLSearchParams(params); next.set('offset', String(value)); setParams(next); }} loading={list.loading} label="Saved case pages" />
    </section></>;
}

function ReferencePicker({ farmId, references, onChange, views = [], disabled = false, onSourcesChanged, onUploadBusy }: { farmId: string; references: CaseReference[]; onChange: (references: CaseReference[]) => void; views?: ReferenceView[]; disabled?: boolean; onSourcesChanged?: () => void; onUploadBusy?: (busy: boolean) => void }) {
  const [kind, setKind] = useState<ReferenceKind>('documents'); const [role, setRole] = useState<ReferenceRole>('evidence'); const [offset, setOffset] = useState(0); const [refresh, setRefresh] = useState(0);
  const list = usePage<RecordItem>(farmId && !disabled ? sourcePath(kind, farmId) : null, offset, refresh);
  const records = (list.page?.items || []).filter(record => record.data.farm_id === farmId);
  useEffect(() => { setOffset(0); }, [farmId, kind]);
  function select(record: RecordItem) { const pin: CaseReference = { kind, id: record.id, revision: record.revision, role }; if (!references.some(item => referenceKey(item) === referenceKey(pin))) onChange([...references, pin]); }
  return <section className="stack"><h3>Records in this case</h3><p>Choose this farm’s records and what each is for.</p>{!disabled && <CaseDocumentAttachment key={farmId} farmId={farmId} references={references} onChange={pins => { onSourcesChanged?.(); onChange(pins); setRefresh(value => value + 1); }} onBusyChange={onUploadBusy} />}
    {!!references.length && <ul className="record-list">{references.map(reference => {
      const sourceView = views.find(item => referenceKey(item) === referenceKey(reference)); const view = sourceView && reference.kind === 'field_change_proposals' ? { ...sourceView, href: referenceHref(reference, farmId) } : sourceView; const current = records.find(record => reference.kind === kind && record.id === reference.id);
      return <li key={referenceKey(reference)}><div><strong>{view?.title || (current ? nameOf(current) : referenceKinds.find(item => item.value === reference.kind)?.label || 'Saved record')}</strong><p>{referenceRoles.find(item => item.value === reference.role)?.label}</p>{view?.current === false && <p>This source is missing or changed. Check it before preparing the case.</p>}<div className="actions"><Link to={internal(view?.href) ? view!.href! : referenceHref(reference, farmId)}>Open source</Link>{!disabled && <Button variant="ghost" onClick={() => onChange(references.filter(item => referenceKey(item) !== referenceKey(reference)))}>Remove from case</Button>}{!disabled && current && current.revision !== reference.revision && <Button variant="secondary" onClick={() => onChange(references.map(item => referenceKey(item) === referenceKey(reference) ? { ...item, revision: current.revision } : item))}>Use the current saved record after checking it</Button>}</div><details><summary>Saved version details</summary><p>Source identity: {reference.id}</p><p>Selected revision {reference.revision}{current ? `; current revision ${current.revision}` : ''}</p></details></div></li>;
    })}</ul>}
    {!references.length && <p>No records selected yet.</p>}
    {!disabled && <><div className="form-grid"><Field label="Find a saved record"><select value={kind} onChange={event => setKind(event.target.value as ReferenceKind)}>{referenceKinds.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field><Field label="What is this record for?"><select value={role} onChange={event => setRole(event.target.value as ReferenceRole)}>{referenceRoles.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field></div>
      {kind === 'field_change_proposals' && <p><Link to={`/app/fields/${farmId}`}>Open my fields to draw or save a field change</Link>. Return here to choose the saved proposal; its identifiers will not be guessed.</p>}
      <Button variant="ghost" onClick={() => { onSourcesChanged?.(); setRefresh(value => value + 1); }}>Refresh available records</Button>{list.loading && <p role="status">Opening this farm’s saved records…</p>}{list.error && <Notice kind="error">{list.error}<Button variant="secondary" onClick={() => { onSourcesChanged?.(); setRefresh(value => value + 1); }}>Retry records</Button></Notice>}
      {list.page && (records.length ? <ul className="farm-plain-list">{records.map(record => <li key={record.id}><div><strong>{nameOf(record)}</strong><p>{record.data.status ? String(record.data.status).replaceAll('_', ' ') : record.data.review_status === 'confirmed' ? 'Checked farm record' : record.data.review_status === 'proposed' ? 'Needs checking' : 'Saved record'}{record.data.reporting_year ? ` · ${record.data.reporting_year}` : ''}{record.data.date ? ` · ${record.data.date}` : ''}</p><details><summary>Saved version details</summary><p>Source identity: {record.id} · revision {record.revision}</p></details></div><Button variant="secondary" disabled={references.length >= 100 || references.some(item => item.kind === kind && item.id === record.id && item.role === role)} onClick={() => select(record)}>Include this record</Button></li>)}</ul> : <p>No eligible record from this farm is on this page. Add or assign the original in <Link to={`/app/documents?farm_id=${farmId}`}>Documents</Link>, or select another record type.</p>)}
      <Pager page={list.page} offset={offset} setOffset={setOffset} loading={list.loading} label="Available source pages" />
    </>}
  </section>;
}

interface CaseFormValue { attempt: string; baseRevision: number; farmId: string; job: CaseJob; year: string; title: string; authority: string; scheme: string; deadline: string; originalReference: string; originalSubmittedAt: string; reason: string; references: CaseReference[] }
function formValue(record?: RecordItem<CaseData>, params?: URLSearchParams): CaseFormValue {
  const data = record?.data; const queryJob = params?.get('job_type'); const job: CaseJob = caseJobs.some(item => item.value === queryJob) ? queryJob as CaseJob : 'fields';
  return { attempt: crypto.randomUUID(), baseRevision: record?.revision || 0, farmId: data?.farm_id || params?.get('farm_id') || '', job: data?.job_type || job, year: data ? String(data.reporting_year) : params?.get('reporting_year') || '', title: data?.title || '', authority: data?.authority || '', scheme: data?.scheme || '', deadline: data?.deadline || '', originalReference: data?.original_reference || '', originalSubmittedAt: data?.original_submitted_at || '', reason: data?.reason || '', references: data?.references || [] };
}
const formContent = (value: CaseFormValue) => JSON.stringify({ title: value.title, authority: value.authority, scheme: value.scheme, deadline: value.deadline, original_reference: value.originalReference, original_submitted_at: value.originalSubmittedAt, reason: value.reason, references: value.references });

function CaseEditor({ record, views, onSaved, onDirty, onSourcesChanged }: { record?: RecordItem<CaseData>; views?: ReferenceView[]; onSaved: (record: RecordItem<CaseData>) => void; onDirty?: (dirty: boolean) => void; onSourcesChanged?: () => void }) {
  const [params] = useSearchParams(); const farms = useRecords('farms'); const initial = useRef(formValue(record, params));
  const draft = usePrivateDraft<CaseFormValue>(record ? `case/${record.id}/details` : `case/new/${params.get('job_type') || 'fields'}/${params.get('farm_id') || 'choose'}/${params.get('reference_id') || 'blank'}`, initial.current);
  const value = draft.value; const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false); const [seedNotice, setSeedNotice] = useState(''); const [seedCandidate, setSeedCandidate] = useState<{ pin: CaseReference; record: RecordItem } | null>(null); const [seedRetry, setSeedRetry] = useState(0);
  const seedApplied = useRef(''); const stale = !!record && value.baseRevision !== record.revision;
  useEffect(() => { if (record) onDirty?.(!draft.ready || formContent(value) !== formContent(formValue(record))); }, [draft.ready, value, record?.revision]);
  useEffect(() => {
    if (record || !draft.ready || !params.get('reference_id')) return;
    const kind = params.get('reference_kind') as ReferenceKind; const role = params.get('reference_role') as ReferenceRole; const revision = Number(params.get('reference_revision')); const id = params.get('reference_id')!;
    if (!referenceKinds.some(item => item.value === kind) || !referenceRoles.some(item => item.value === role) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || !Number.isInteger(revision) || revision < 1) { setSeedNotice('The linked record could not be selected from this link. Choose the actual saved record below.'); return; }
    if (value.farmId !== params.get('farm_id')) { setSeedNotice('The linked source belongs to the farm in the original link. Choose records for your selected farm below.'); return; }
    const key = `${kind}/${id}/${revision}/${role}/${value.farmId}/${seedRetry}`; if (seedApplied.current === key) return;
    let active = true; setSeedCandidate(null); setSeedNotice('Checking the current linked record…');
    api.get<RecordItem>(referenceDetailPath({ kind, id })).then(source => {
      if (!active) return; if (source.data.farm_id !== value.farmId) throw new Error('That source is not available as a record from this farm.');
      const pin: CaseReference = { kind, id, revision, role };
      if (source.revision !== revision) { setSeedNotice('The linked record changed after this link was made. It has not been silently refreshed or selected. Open it and choose the current version only after checking it.'); setSeedCandidate({ pin, record: source }); }
      else if (value.references.some(item => referenceKey(item) === referenceKey(pin) && item.revision !== source.revision)) { setSeedNotice('Your private draft retains an earlier source revision. It has not been replaced. Compare the source and explicitly choose its current revision if it belongs in this case.'); setSeedCandidate({ pin, record: source }); }
      else if (value.references.length >= 100 && !value.references.some(item => referenceKey(item) === referenceKey(pin))) setSeedNotice('This draft already has 100 selected records. Remove a record before including the linked source.');
      else { draft.setValue(previous => previous.references.some(item => referenceKey(item) === referenceKey(pin)) ? previous : { ...previous, references: [...previous.references, pin], attempt: crypto.randomUUID() }); setSeedNotice('The linked record is selected at its current saved revision. This does not record an official submission.'); }
      seedApplied.current = key;
    }).catch(failure => { if (active) setSeedNotice(`The linked source is unavailable. ${errorMessage(failure)} Choose a saved record below or retry.`); });
    return () => { active = false; };
  }, [record?.id, draft.ready, value.farmId, seedRetry, params.toString()]);
  function set<K extends keyof CaseFormValue>(key: K, next: CaseFormValue[K]) { draft.setValue(previous => ({ ...previous, [key]: next, attempt: crypto.randomUUID() })); setError(''); onDirty?.(true); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft.ready || busy || uploading || stale) return; setBusy(true); setError('');
    const data = { title: value.title, authority: value.authority || null, scheme: value.scheme || null, deadline: value.deadline || null, original_reference: value.originalReference || null, original_submitted_at: value.originalSubmittedAt || null, reason: value.reason || null, references: value.references };
    try { const saved = record ? await api.patch<RecordItem<CaseData>>(`/cases/${record.id}`, { expected_revision: value.baseRevision, data }) : await api.post<RecordItem<CaseData>>('/cases', { ...data, farm_id: value.farmId, job_type: value.job, reporting_year: Number(value.year) }, { idempotencyKey: value.attempt }); if (saved.data.farm_id !== value.farmId || record && saved.id !== record.id) throw new Error('The saved response belongs to another farm or case. Your private entries are retained.'); await draft.clear(); onDirty?.(false); onSaved(saved); }
    catch (failure) { setError(`${errorMessage(failure)}${failure instanceof ApiError && failure.status === 409 ? ' Your private entries are retained. Reload the saved case and compare before trying again.' : ''}`); } finally { setBusy(false); }
  }
  return <section className="card"><h2>{record ? 'Case details and selected records' : jobTitle(value.job)}</h2><p>{value.job === 'correction' ? 'Start with what you originally sent, explain what is wrong and select the correction. Do not enter a receipt or acceptance unless it actually exists.' : value.job === 'inspection' ? 'Start with the actual notice, request or checklist. Add each requested record or finding as an item to work through.' : 'Choose the saved field change you want to check. An app review never changes the authority’s land register.'}</p><DraftState {...draft} />{error && <Notice kind="error">{error}</Notice>}
    {stale && <Notice kind="warning"><p>The saved case changed after these private entries were started. Your entries have not been replaced. Compare every saved detail before choosing which values to keep.</p><details open><summary>Compare the latest saved case</summary><dl className="detail-grid">{[['Name', record!.data.title], ['Authority or recipient', record!.data.authority], ['Application or scheme', record!.data.scheme], ['Recorded deadline', record!.data.deadline], ['Original reference', record!.data.original_reference], ['Original sending date supplied', record!.data.original_submitted_at], ['Explanation', record!.data.reason]].map(([label, content]) => <div key={label}><dt>{label}</dt><dd>{content || 'Not recorded'}</dd></div>)}</dl><h3>Records currently saved in the case</h3>{record!.data.references.length ? <ul>{record!.data.references.map(reference => <li key={referenceKey(reference)}>{referenceKinds.find(item => item.value === reference.kind)?.label} · {referenceRoles.find(item => item.value === reference.role)?.label} <Link to={referenceHref(reference, record!.data.farm_id)}>Open this saved source</Link><details><summary>Saved version details</summary><p>Source identity: {reference.id}</p><p>Selected revision: {reference.revision}</p></details></li>)}</ul> : <p>No source is currently selected.</p>}<details><summary>Saved version details</summary><p>Saved case revision {record!.revision}; private draft started at revision {value.baseRevision}.</p></details></details><p>Keeping your entries will keep your private field values and source selections instead of replacing them with the saved values above.</p><Button variant="secondary" onClick={() => set('baseRevision', record!.revision)}>Keep my entries after comparing the saved case</Button></Notice>}
    {seedNotice && <Notice>{seedNotice}{seedCandidate && <div className="actions"><Link to={referenceHref(seedCandidate.pin, value.farmId)}>Open the current source</Link><Button variant="secondary" onClick={() => { const pin = { ...seedCandidate.pin, revision: seedCandidate.record.revision }; set('references', [...value.references.filter(item => referenceKey(item) !== referenceKey(pin)), pin]); setSeedCandidate(null); setSeedNotice('You explicitly selected the current source revision. Check it with the rest of the case.'); }}>Use the current source after checking it</Button></div>}{!seedCandidate && <Button variant="ghost" onClick={() => setSeedRetry(previous => previous + 1)}>Check linked source again</Button>}</Notice>}
    <form className="stack" onSubmit={save}><fieldset className="draft-fields" disabled={!draft.ready || busy || uploading}><div className="form-grid">
      {!record && <><Field label="Farm"><select required value={value.farmId} onChange={event => { draft.setValue(previous => ({ ...previous, farmId: event.target.value, references: [], attempt: crypto.randomUUID() })); }}><option value="">Choose the farm</option>{farms.items.map(farm => <option value={farm.id} key={farm.id}>{nameOf(farm)}</option>)}</select></Field><Field label="What do you need to do?"><select value={value.job} onChange={event => set('job', event.target.value as CaseJob)}>{caseJobs.map(item => <option value={item.value} key={item.value}>{item.title}</option>)}</select></Field><Field label="Year these records cover"><input required type="number" min="1900" max="2200" value={value.year} onChange={event => set('year', event.target.value)} /></Field></>}
      <Field label="Name this case"><input required maxLength={240} value={value.title} onChange={event => set('title', event.target.value)} placeholder={value.job === 'inspection' ? 'Inspection records requested in the letter' : value.job === 'correction' ? 'Correct the field area in my submitted application' : 'Check this year’s field changes'} /></Field>
      <Field label="Authority or recipient, if known"><input maxLength={240} value={value.authority} onChange={event => set('authority', event.target.value)} /></Field><Field label="Application or scheme, if known"><input maxLength={240} value={value.scheme} onChange={event => set('scheme', event.target.value)} /></Field><Field label="Actual deadline, if recorded"><input type="date" value={value.deadline} onChange={event => set('deadline', event.target.value)} /></Field>
      <Field label="Original submission reference, if you have one"><input maxLength={240} value={value.originalReference} onChange={event => set('originalReference', event.target.value)} /></Field><Field label="Date you actually sent the original, if known"><input type="date" max={today()} value={value.originalSubmittedAt} onChange={event => set('originalSubmittedAt', event.target.value)} /></Field><Field label={value.job === 'correction' ? 'What is wrong, and what should change?' : 'What needs checking or preparing?'}><textarea maxLength={4000} value={value.reason} onChange={event => set('reason', event.target.value)} required={value.job === 'correction'} /></Field>
    </div>{value.farmId && <ReferencePicker farmId={value.farmId} references={value.references} views={views} onChange={references => set('references', references)} onSourcesChanged={onSourcesChanged} onUploadBusy={setUploading} />}{farms.error && <Notice kind="error">{farms.error}<Button variant="ghost" onClick={() => void farms.reload()}>Retry farms</Button></Notice>}<Button type="submit" loading={busy} disabled={stale || uploading || !value.farmId || !value.year}>{record ? 'Save case details and records' : 'Save this case'}</Button><p className="muted">Save preparation here, then use the official route when ready to send.</p></fieldset></form>
  </section>;
}

export function NewCasePage() {
  const navigate = useNavigate(); const [params] = useSearchParams(); const { session } = useSession(); const canWrite = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  if (params.get('job_type') === 'correction' && params.get('focused') === '1') return <NewCorrectionWizard />;
  return <><PageHeader title="Start with the job in front of you" description="Use the records you already have. Missing details stay visible for you to check." /><Link to="/app/cases">All paperwork cases</Link>{canWrite ? <CaseEditor key={`${session?.workspace.id}/${params}`} onSaved={record => navigate(`/app/cases/${record.id}`)} /> : <Notice>Your current permission is read-only. Ask the farm owner or a delegated reviewer to start this case.</Notice>}</>;
}

type DocumentChoice = { id: string; revision: number; title: string };
function DocumentPicker({ farmId, choices, onChange, single = false, disabled = false, onRefresh }: { farmId: string; choices: DocumentChoice[]; onChange: (choices: DocumentChoice[]) => void; single?: boolean; disabled?: boolean; onRefresh?: () => void }) {
  const [offset, setOffset] = useState(0); const [refresh, setRefresh] = useState(0);
  const list = usePage<RecordItem>(sourcePath('documents', farmId), offset, refresh);
  const records = (list.page?.items || []).filter(record => record.data.farm_id === farmId);
  return <section className="stack"><h4>{single ? 'Actual response or receipt document' : 'Documents that support this item'}</h4><p>Only documents assigned to this farm can be used.</p>
    {!!choices.length && <ul>{choices.map(choice => <li key={choice.id}><Link to={`/app/documents/${choice.id}`}>{choice.title || 'Selected document'}</Link> <Button variant="ghost" disabled={disabled} onClick={() => onChange(choices.filter(item => item.id !== choice.id))}>Remove document</Button><details><summary>Saved version details</summary><p>Document identity: {choice.id} · selected revision {choice.revision || 'not loaded'}</p></details></li>)}</ul>}
    <Button variant="ghost" disabled={disabled} onClick={() => { onRefresh?.(); setRefresh(value => value + 1); }}>Refresh documents</Button>
    {list.loading && <p role="status">Opening documents…</p>}{list.error && <Notice kind="error">{list.error} Your choices are retained.<Button variant="secondary" onClick={() => { onRefresh?.(); setRefresh(value => value + 1); }}>Retry documents</Button></Notice>}
    {list.page && (records.length ? records.map(record => { const selected = choices.find(choice => choice.id === record.id); return <div key={record.id}><label className="check-row"><input type="checkbox" checked={!!selected} disabled={disabled} onChange={event => onChange(event.target.checked ? [...(single ? [] : choices.filter(choice => choice.id !== record.id)), { id: record.id, revision: record.revision, title: nameOf(record) }] : choices.filter(choice => choice.id !== record.id))} /><span>{nameOf(record)}</span></label>{selected && selected.revision !== record.revision && <><strong>The selected document has changed.</strong><Button variant="secondary" disabled={disabled} onClick={() => onChange(choices.map(choice => choice.id === record.id ? { id: record.id, revision: record.revision, title: nameOf(record) } : choice))}>Use the current document after checking it</Button></>}<details><summary>Saved version details</summary><p>Document identity: {record.id} · current revision {record.revision}</p></details></div>; }) : <p>No document from this farm is on this page. <Link to={`/app/documents?farm_id=${farmId}`}>Add the actual document</Link> before recording a receipt or acceptance.</p>)}
    <Pager page={list.page} offset={offset} setOffset={setOffset} loading={list.loading} label="Evidence document pages" />
  </section>;
}

function CaseItemReview({ record, item, onSaved }: { record: RecordItem<CaseData>; item: CaseItem; onSaved: (record: RecordItem<CaseData>) => void }) {
  const draft = usePrivateDraft<{ attempt: string; status: 'in_progress' | 'resolved' | 'cancelled'; note: string; documents: DocumentChoice[] }>(`case/${record.id}/item/${item.id}`, { attempt: crypto.randomUUID(), status: 'in_progress', note: '', documents: [] });
  const [ack, setAck] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useClearAcknowledgement(() => setAck(false), record.revision);
  function edit(next: Partial<typeof draft.value>) { draft.setValue(previous => ({ ...previous, ...next, attempt: crypto.randomUUID() })); setAck(false); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft.ready || !ack || busy) return; setBusy(true); setError('');
    try { const saved = await api.post<RecordItem<CaseData>>(`/cases/${record.id}/items/${item.id}/review`, { expected_revision: record.revision, status: draft.value.status, note: draft.value.note, document_ids: draft.value.documents.map(document => document.id), document_revisions: Object.fromEntries(draft.value.documents.map(document => [document.id, document.revision])), acknowledged: true }, { idempotencyKey: `${draft.value.attempt}:${record.revision}` }); if (saved.id !== record.id) throw new Error('The saved item response belongs to another case. Reload before retrying.'); await draft.clear(); setAck(false); onSaved(saved); }
    catch (failure) { setError(errorMessage(failure)); setAck(false); } finally { setBusy(false); }
  }
  return <details><summary>Record progress or resolve this item</summary><DraftState {...draft} />{error && <Notice kind="error">{error}</Notice>}<form onSubmit={save} className="stack"><fieldset disabled={!draft.ready || busy}><Field label="What happened to this item?"><select value={draft.value.status} onChange={event => edit({ status: event.target.value as 'in_progress' | 'resolved' | 'cancelled' })}><option value="in_progress">I am working on it</option><option value="resolved">Resolved, with the supporting documents</option><option value="cancelled">Set aside, with a reason</option></select></Field><Field label="What did you check or change?"><textarea required maxLength={4000} value={draft.value.note} onChange={event => edit({ note: event.target.value })} /></Field><DocumentPicker farmId={record.data.farm_id} choices={draft.value.documents} onChange={documents => edit({ documents })} onRefresh={() => setAck(false)} disabled={busy} /><label className="check-row"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />I checked this item and the selected documents. This records my judgement, not an authority decision.</label><Button type="submit" loading={busy} disabled={!ack || draft.value.status === 'resolved' && !draft.value.documents.length}>Save item progress</Button></fieldset></form></details>;
}

function CaseItems({ record, canWrite, onSaved }: { record: RecordItem<CaseData>; canWrite: boolean; onSaved: (record: RecordItem<CaseData>) => void }) {
  const draft = usePrivateDraft<{ attempt: string; kind: CaseItem['kind']; title: string; description: string; dueDate: string }>(`case/${record.id}/new-item`, { attempt: crypto.randomUUID(), kind: 'requested_record', title: '', description: '', dueDate: '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const editable = editableCase(record) && canWrite;
  function edit(next: Partial<typeof draft.value>) { draft.setValue(previous => ({ ...previous, ...next, attempt: crypto.randomUUID() })); }
  async function add(event: FormEvent) {
    event.preventDefault(); if (!draft.ready || busy) return; setBusy(true); setError('');
    try { const saved = await api.post<RecordItem<CaseData>>(`/cases/${record.id}/items`, { expected_revision: record.revision, kind: draft.value.kind, title: draft.value.title, description: draft.value.description || null, due_date: draft.value.dueDate || null }, { idempotencyKey: `${draft.value.attempt}:${record.revision}` }); if (saved.id !== record.id) throw new Error('The saved item response belongs to another case. Reload before retrying.'); await draft.clear(); onSaved(saved); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <section className="paper-section" id="case-items"><h2>{record.data.job_type === 'inspection' ? 'Requested records and inspection findings' : 'Things to finish before sending'}</h2><p>Write down each requested record, finding or action. An unresolved item blocks preparation in this app; it does not establish a legal duty or compliance.</p>{(record.data.items || []).length ? <ul className="record-list">{record.data.items.map(item => <li key={item.id}><article id={`item-${item.id}`}><h3>{item.title}</h3><p>{item.description}</p><p>{item.status === 'open' ? 'Still to do' : item.status === 'in_progress' ? 'In progress' : item.status === 'resolved' ? 'Resolved by a person' : 'Set aside by a person'}{item.due_date ? ` · recorded date ${item.due_date}` : ''}</p>{item.review && <p>Recorded review: {item.review.note} · {new Date(item.review.at).toLocaleString()}</p>}{!!item.document_pins?.length && <ul>{item.document_pins.map(document => <li key={document.id}><Link to={`/app/documents/${document.id}`}>Supporting document</Link><details><summary>Saved version details</summary><p>Document identity: {document.id} · retained revision {document.revision}</p></details></li>)}</ul>}{editable && <CaseItemReview record={record} item={item} onSaved={onSaved} />}</article></li>)}</ul> : <p>No individual item is recorded. If the notice asks for records or lists findings, add them here instead of assuming they are complete.</p>}
    {editable && <details><summary>Add a requested record, finding or action</summary><DraftState {...draft} />{error && <Notice kind="error">{error}</Notice>}<form className="stack" onSubmit={add}><fieldset disabled={!draft.ready || busy || record.data.items.length >= 100}><div className="form-grid"><Field label="Type of item"><select value={draft.value.kind} onChange={event => edit({ kind: event.target.value as CaseItem['kind'] })}><option value="requested_record">A requested record</option><option value="finding">An inspection finding</option><option value="action">An action to take</option></select></Field><Field label="What needs doing?"><input required maxLength={240} value={draft.value.title} onChange={event => edit({ title: event.target.value })} /></Field><Field label="Details from the request or finding"><textarea maxLength={4000} value={draft.value.description} onChange={event => edit({ description: event.target.value })} /></Field><Field label="Actual due date, if given"><input type="date" value={draft.value.dueDate} onChange={event => edit({ dueDate: event.target.value })} /></Field></div><Button type="submit" loading={busy}>Add this item</Button></fieldset></form></details>}
    {!editableCase(record) && <p>Reopen preparation before changing the items. Earlier sending records remain in the history.</p>}
  </section>;
}

function EventForm({ record, onSaved }: { record: RecordItem<CaseData>; onSaved: (record: RecordItem<CaseData>) => void }) {
  const allowed = availableActions(record.data.status);
  const defaultAction: CaseAction = record.data.status === 'receipt_saved' ? 'accepted' : allowed[0];
  const draft = usePrivateDraft<{ attempt: string; action: CaseAction; date: string; note: string; reference: string; documents: DocumentChoice[] }>(`case/${record.id}/event`, { attempt: crypto.randomUUID(), action: defaultAction, date: '', note: '', reference: '', documents: [] });
  const value = draft.value; const [ack, setAck] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useClearAcknowledgement(() => setAck(false), record.revision);
  function set<K extends keyof typeof value>(key: K, next: typeof value[K]) { draft.setValue(previous => ({ ...previous, [key]: next, attempt: crypto.randomUUID() })); setAck(false); setError(''); }
  const needsDocument = value.action === 'receipt' || value.action === 'accepted';
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft.ready || !ack || busy || !allowed.includes(value.action)) return; setBusy(true); setError(''); const document = needsDocument ? value.documents[0] : undefined;
    try { const result = await api.post<CaseEventResult>(`/cases/${record.id}/events`, { expected_revision: record.revision, action: value.action, date: value.date, note: value.note, reference: value.reference || null, ...(document ? { document_id: document.id, document_revision: document.revision } : {}), acknowledged: true }, { idempotencyKey: `${value.attempt}:${record.revision}` }); if (result.case.id !== record.id) throw new Error('The saved event response belongs to another case. Reload before retrying.'); await draft.clear(); setAck(false); onSaved(result.case); }
    catch (failure) { setError(errorMessage(failure)); setAck(false); } finally { setBusy(false); }
  }
  return <section className="paper-section" id="case-delivery"><h2>Record what actually happened</h2><p>Nothing is sent from this form. Use it after you send the records yourself or receive a real response. A delivery receipt and an acceptance are different events.</p>
    <DraftState {...draft} />{error && <Notice kind="error">{error} Your unsaved details remain here. Check the latest case before retrying.</Notice>}{!allowed.includes(value.action) && <Notice kind="warning">Your retained event draft is not available at the current case stage. Choose what actually happened without discarding your written details.</Notice>}
    <form className="stack" onSubmit={save}><fieldset disabled={!draft.ready || busy}><div className="form-grid">
      <Field label="What happened?"><select value={value.action} onChange={event => set('action', event.target.value as CaseAction)}>{(Object.keys(actionLabel) as CaseAction[]).map(action => <option key={action} value={action} disabled={!allowed.includes(action)}>{actionLabel[action]}</option>)}</select></Field>
      <Field label="Actual date"><input required type="date" max={today()} value={value.date} onChange={event => set('date', event.target.value)} /></Field><Field label={needsDocument ? 'Actual response reference' : 'Reference, if one was supplied'}><input required={needsDocument} maxLength={240} value={value.reference} onChange={event => set('reference', event.target.value)} /></Field><Field label="What did you send, receive or decide?"><textarea required maxLength={4000} value={value.note} onChange={event => set('note', event.target.value)} /></Field>
    </div>{needsDocument && <DocumentPicker farmId={record.data.farm_id} choices={value.documents} onChange={documents => set('documents', documents)} single disabled={busy} onRefresh={() => setAck(false)} />}{value.action === 'sent' && <Notice>First review the current selected records and use the handoff instructions. Record sending only after you have actually sent them through the official route.</Notice>}
      <label className="check-row"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />I confirm this actually happened as described. This is my record; the app has not verified it with an authority.</label><Button type="submit" loading={busy} disabled={!ack || !allowed.includes(value.action) || needsDocument && (!value.reference.trim() || !value.documents.length)}>{actionLabel[value.action]}</Button>
    </fieldset></form></section>;
}

type HistoricalDownload = (href: string, label: string, eventId: string, eventRevision: number, fingerprint: string) => void;
function RetainedEvent({ caseId, farmId, eventId, onDownload, downloading, transfer, onCancel }: { caseId: string; farmId: string; eventId: string; onDownload: HistoricalDownload; downloading: boolean } & FolderControls) {
  const [event, setEvent] = useState<RecordItem<CaseEventData> | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function open() {
    setLoading(true); setError('');
    try { const value = await api.get<RecordItem<CaseEventData>>(`/cases/${caseId}/events/${eventId}`); if (value.id !== eventId || value.data.case_id !== caseId || value.data.farm_id !== farmId) throw new Error('This history entry belongs to another case or farm.'); if (mounted.current) setEvent(value); }
    catch (failure) { if (mounted.current) setError(errorMessage(failure)); } finally { if (mounted.current) setLoading(false); }
  }
  const content = event?.data.sealed_bundle?.content || event?.data.changes;
  const fields: [keyof CaseData, string][] = [['title', 'Case title'], ['authority', 'Recorded authority or recipient'], ['scheme', 'Recorded scheme'], ['reporting_year', 'Reporting year'], ['deadline', 'Recorded deadline'], ['original_reference', 'Original reference'], ['original_submitted_at', 'Recorded original sending date'], ['reason', 'Reason and changes']];
  return <div className="stack"><Button variant="secondary" loading={loading} onClick={() => void open()}>{event ? 'Reload this retained history entry' : 'Open retained details and source versions'}</Button>{error && <Notice kind="error">{error} The retained selection is unavailable; no current selection has been substituted.</Notice>}
    {event && <section className="card"><h4>{event.data.sealed_bundle ? 'Historical selection recorded as sent' : 'Retained workspace entry'}</h4>{event.data.sealed_bundle && <Notice kind="warning">This is the selection the person recorded as sent, not a fresh review of current records. Later corrections do not replace these retained versions.</Notice>}
      {content && <dl className="detail-grid">{fields.filter(([key]) => Object.hasOwn(content, key)).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{content[key] === null || content[key] === '' ? 'Not recorded' : String(content[key])}</dd></div>)}</dl>}
      {!!content?.references?.length && <ul>{content.references.map(reference => <li key={referenceKey(reference)}><strong>{referenceKinds.find(item => item.value === reference.kind)?.label}</strong> · {referenceRoles.find(item => item.value === reference.role)?.label}<p><Link to={referenceHref(reference, farmId)}>Open the source record and compare it with the retained selection</Link></p><details><summary>Saved version details</summary><p>Source identity: {reference.id}</p><p>Retained revision {reference.revision}</p></details></li>)}</ul>}
      {!!content?.items?.length && <ul>{content.items.map(item => <li key={item.id}>{item.title} · {item.status}{item.review?.note ? ` · ${item.review.note}` : ''}</li>)}</ul>}
      {event.data.item && <p>{event.data.item.title} · {event.data.item.status}{event.data.item.review?.note ? ` · ${event.data.item.review.note}` : ''}</p>}
      {event.data.review?.fingerprint && <details><summary>Saved version details</summary><p className="muted" style={{ overflowWrap: 'anywhere' }}>Retained review fingerprint: {event.data.review.fingerprint}</p></details>}
      {event.data.sealed_bundle?.handoff && <Handoff handoff={{ ...event.data.sealed_bundle.handoff, origin: 'sealed_sent_bundle' }} onDownload={(href, label) => onDownload(href, label, event.id, event.revision, event.data.sealed_bundle!.handoff.reference_fingerprint)} downloading={downloading} transfer={transfer} onCancel={onCancel} />}
    </section>}
  </div>;
}

function EventHistory({ caseId, farmId, refresh, onDownload, downloading, transfer, onCancel }: { caseId: string; farmId: string; refresh: number; onDownload: HistoricalDownload; downloading: boolean } & FolderControls) {
  const [offset, setOffset] = useState(0); const [retry, setRetry] = useState(0); const history = usePage<RecordItem<CaseEventData>>(`/cases/${caseId}/events`, offset, refresh + retry);
  useEffect(() => { setOffset(0); }, [caseId]);
  return <section className="paper-section"><h2>What was recorded before</h2><p>Preparing or reviewing records is different from sending them or receiving a response. This history is not an independent authority check.</p>{history.loading && <p role="status">Opening the case history…</p>}{history.error && <Notice kind="error">{history.error}<Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Retry history</Button></Notice>}
    {history.page && (history.page.items.length ? <ol>{history.page.items.map(event => <li key={event.id}><h3>{eventName(event.data.action)}</h3><p>{event.data.date || event.data.recorded_at || event.created_at}{event.data.note ? ` · ${event.data.note}` : ''}</p>{event.data.reference && <p>Recorded reference: {event.data.reference}</p>}{event.data.document_id && <><p><Link to={`/app/documents/${event.data.document_id}`}>Recorded response document</Link></p><details><summary>Saved version details</summary><p>Document revision {event.data.document_revision}</p></details></>}<p className="muted">Saved {new Date(event.created_at).toLocaleString()}</p><RetainedEvent key={event.id} caseId={caseId} farmId={farmId} eventId={event.id} onDownload={onDownload} downloading={downloading} transfer={transfer} onCancel={onCancel} /></li>)}</ol> : <p>No case history entry is recorded.</p>)}
    <Pager page={history.page} offset={offset} setOffset={setOffset} loading={history.loading} label="Case history pages" />
  </section>;
}

function Handoff({ handoff, onDownload, downloading, transfer, onCancel }: { handoff: CaseHandoff; onDownload: (href: string, label: string) => void; downloading: boolean } & FolderControls) {
  const [copyNotice, setCopyNotice] = useState('');
  const folder = handoff.downloads.find(download => isPreparedFolder(download.href));
  const individualFiles = handoff.downloads.filter(download => !isPreparedFolder(download.href));
  const valueText = (value: unknown) => value === null || value === undefined ? 'Not recorded' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const copyText = handoff.fields.map(field => `${field.label}: ${valueText(field.value)}`).join('\n\n');
  async function copy() { try { await navigator.clipboard.writeText(copyText); setCopyNotice('The handoff text is copied. Review it in the official form before sending.'); } catch { setCopyNotice('Copying is unavailable. Select and copy the text below yourself.'); } }
  return <section className="paper-section"><h2>{handoff.origin === 'sealed_sent_bundle' ? 'Retained handoff for the recorded sending' : 'Take these records to the official route'}</h2>
    {handoff.origin === 'sealed_sent_bundle' && <Notice kind="warning">Historical selection only. These are the retained source versions from that sending record, not a new check of current sources.</Notice>}<Notice>{handoff.notice}</Notice>
    {folder ? <><p>Includes the selected records and their original attachments. Nothing is sent.</p><p>The folder includes documents you selected here, documents attached to completed items, and attachments selected in your approved reports. Other private source files stay in your workspace.</p><Button loading={downloading} onClick={() => onDownload(folder.href, folder.label)}>Download complete prepared folder (ZIP)</Button></> : <p>No complete folder download is available for this saved version. The available individual files are listed below.</p>}
    {transfer && handoff.downloads.some(download => download.href === transfer.href) && <div className="notice" aria-live="polite"><p>{transfer.cancelling ? 'Cancelling the folder download…' : transfer.total === null ? 'Checking this saved folder before downloading…' : `Downloading the complete folder: ${(transfer.received / (1024 * 1024)).toFixed(1)} of ${(transfer.total / (1024 * 1024)).toFixed(1)} MiB.`}</p>{transfer.total !== null && <progress value={transfer.received} max={transfer.total} aria-label="Complete prepared folder download" />}<Button variant="secondary" disabled={transfer.cancelling} onClick={onCancel}>Cancel folder download</Button></div>}
    {!!individualFiles.length && <details><summary>Individual files</summary><div className="actions">{individualFiles.map((download, index) => <Button key={`${download.href}-${index}`} variant="secondary" loading={downloading} onClick={() => onDownload(download.href, download.label)}>Download {download.label}</Button>)}</div></details>}
    <p>Check the recipient’s instructions and national requirements yourself. The app does not prefill, transmit or certify an official submission.</p><Field label="Text you can copy into the official process"><textarea readOnly rows={Math.min(18, Math.max(5, copyText.split('\n').length))} value={copyText} /></Field><Button variant="secondary" onClick={() => void copy()}>Copy the handoff text</Button>{copyNotice && <p role="status">{copyNotice}</p>}
    {handoff.official_url && /^https:\/\//.test(handoff.official_url) ? <p><a className="button button-secondary" href={handoff.official_url} target="_blank" rel="noreferrer">Open the official route</a></p> : <p>No official route is supplied for this case. Check the original notice or ask the authority where to send it.</p>}
    <details><summary>Saved version details</summary><p className="muted">Selected source fingerprint: <span style={{ overflowWrap: 'anywhere' }}>{handoff.reference_fingerprint}</span></p></details>
  </section>;
}

export function CaseDetailPage() {
  const { id } = useParams(); const { session } = useSession();
  return <CaseDetail key={`${session?.user.id}/${session?.workspace.id}/${id}`} id={id || ''} />;
}

function CaseDetail({ id }: { id: string }) {
  const { session } = useSession(); const canWrite = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  const [record, setRecord] = useState<RecordItem<CaseData> | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [refresh, setRefresh] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [checks, setChecks] = useState<CaseChecks | null>(null); const [checkLoading, setCheckLoading] = useState(false); const [checkError, setCheckError] = useState(''); const [ack, setAck] = useState(false); const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState('');
  const [handoff, setHandoff] = useState<CaseHandoff | null>(null); const [handoffError, setHandoffError] = useState(''); const [eventsRefresh, setEventsRefresh] = useState(0);
  const [packetProgress, setPacketProgress] = useState<FolderTransfer | null>(null); const [packetNotice, setPacketNotice] = useState('');
  const downloadRequest = useRef<AbortController | null>(null);
  const generation = useRef(0); const mounted = useRef(true); const reviewAttempt = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; downloadRequest.current?.abort(); }; }, []);
  function invalidate() { generation.current += 1; downloadRequest.current?.abort(); setChecks(null); setAck(false); setHandoff(null); }
  function cancelFolder() { downloadRequest.current?.abort(); setPacketProgress(previous => previous ? { ...previous, cancelling: true } : null); }
  useEffect(() => {
    let active = true; setLoading(true); setError(''); invalidate();
    api.get<RecordItem<CaseData>>(`/cases/${id}`).then(value => { if (value.id !== id) throw new Error('The returned record belongs to another case. Reload this case.'); if (active) setRecord(previous => previous && previous.revision > value.revision ? previous : value); }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, refresh, session?.workspace.id]);
  useEffect(() => { setRecord(null); setDirty(false); setMessage(''); }, [id, session?.workspace.id]);
  function saved(next: RecordItem<CaseData>) { if (!mounted.current || next.id !== id) return; setRecord(previous => previous && previous.revision > next.revision ? previous : next); invalidate(); setEventsRefresh(value => value + 1); setMessage('Saved in your farm workspace. Review the current records again before any sending step.'); }
  async function check() {
    if (!record) return; setCheckLoading(true); setCheckError(''); invalidate(); const binding = generation.current;
    try { const value = await api.get<CaseChecks>(`/cases/${record.id}/checks`); if (!mounted.current || binding !== generation.current) return; if (value.case_id !== id) throw new Error('The returned check belongs to another case. Reload this case.'); setChecks(value); if (value.case_revision !== record.revision) setCheckError('The saved case changed. Reload it and compare your private entries before reviewing.'); }
    catch (failure) { if (mounted.current && binding === generation.current) setCheckError(errorMessage(failure)); } finally { if (mounted.current) setCheckLoading(false); }
  }
  async function review() {
    if (!record || !checks || !ack || dirty || checks.case_revision !== record.revision) return; setBusy('review'); setError('');
    try { const body = { expected_revision: record.revision, expected_fingerprint: checks.fingerprint, acknowledged: true }; const serialized = JSON.stringify(body); const attempt = reviewAttempt.current?.body === serialized ? reviewAttempt.current : { body: serialized, key: crypto.randomUUID() }; reviewAttempt.current = attempt; const next = await api.post<RecordItem<CaseData>>(`/cases/${record.id}/review`, body, { idempotencyKey: attempt.key }); if (next.id !== id) throw new Error('The returned saved record belongs to another case. Reload this case.'); saved(next); if (mounted.current) setMessage('This saved version is reviewed and ready for you to send yourself. Nothing has been sent.'); }
    catch (failure) { setError(errorMessage(failure)); invalidate(); } finally { setBusy(''); }
  }
  async function openHandoff() {
    if (!record) return; setBusy('handoff'); setHandoffError(''); setHandoff(null); const binding = generation.current;
    try { const value = await api.get<CaseHandoff>(`/cases/${record.id}/handoff`); if (!mounted.current || binding !== generation.current) return; if (value.case_id !== id) throw new Error('This handoff belongs to another case. Reload before using it.'); setHandoff(value); } catch (failure) { if (mounted.current && binding === generation.current) setHandoffError(errorMessage(failure)); } finally { if (mounted.current) setBusy(''); }
  }
  async function download(href: string, label: string, context: { fingerprint: string; origin?: CaseHandoff['origin']; eventId?: string; eventRevision?: number }) {
    if (!record || downloadRequest.current) return;
    const controller = new AbortController(); downloadRequest.current = controller;
    const folderRequested = isPreparedFolder(href);
    setBusy('download'); setHandoffError(''); setPacketNotice(''); const binding = generation.current;
    if (folderRequested) setPacketProgress({ href, received: 0, total: null });
    try {
      let current: CaseHandoff;
      let selectedHistoricalRevision: number | null = null;
      if (context.eventId) {
        const path = `/cases/${id}/events/${context.eventId}`;
        const retained = folderRequested ? await (await api.downloadResponse(path, { signal: controller.signal })).json() as RecordItem<CaseEventData> : await api.get<RecordItem<CaseEventData>>(path);
        if (retained.id !== context.eventId || retained.revision !== context.eventRevision || retained.data.case_id !== id || retained.data.farm_id !== record.data.farm_id || !retained.data.sealed_bundle) throw new Error('This retained sending selection changed or is unavailable. Reopen that history entry.');
        current = retained.data.sealed_bundle.handoff;
        selectedHistoricalRevision = retained.data.sealed_bundle.case_revision;
      } else {
        const path = `/cases/${id}/handoff`;
        current = folderRequested ? await (await api.downloadResponse(path, { signal: controller.signal })).json() as CaseHandoff : await api.get<CaseHandoff>(path);
        if (current.origin !== context.origin) throw new Error('The handoff stage changed. Reopen the handoff before downloading.');
      }
      if (controller.signal.aborted) throw cancelledDownload();
      if (!mounted.current || binding !== generation.current) throw new Error('The selection changed while checking this download. Reopen the handoff or retained history entry.');
      if (current.case_id !== id || current.reference_fingerprint !== context.fingerprint || !current.downloads.some(download => download.href === href)) throw new Error('This file no longer belongs to the selected handoff. Reopen and check the selection.');
      const url = new URL(href, window.location.origin);
      const packet = packetPath.exec(url.pathname);
      if (url.origin !== window.location.origin || url.hash || (!packet && !/^\/(?:api\/v1\/)?(?:reports\/[a-zA-Z0-9-]+\/download|field-proposals\/[a-zA-Z0-9-]+\/export)$/.test(url.pathname))) throw new Error('This download is not a farm workspace export.');
      const expected = url.searchParams.get('expected_revision'); const retained = url.searchParams.get('retained_revision');
      const validRevision = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
      if (expected !== null && retained !== null || expected !== null && !validRevision(expected) || retained !== null && !validRevision(retained) || url.searchParams.getAll('expected_revision').length > 1 || url.searchParams.getAll('retained_revision').length > 1) throw new Error('The export revision is not a valid selected version.');
      if (packet) {
        const fingerprint = url.searchParams.get('reference_fingerprint');
        const historical = !!context.eventId || context.origin === 'sealed_sent_bundle';
        const allowed = new Set(['reference_fingerprint', historical ? 'retained_revision' : 'expected_revision']);
        if (packet[1].toLowerCase() !== id.toLowerCase() || !fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint) || fingerprint !== context.fingerprint || url.searchParams.getAll('reference_fingerprint').length !== 1 || [...url.searchParams.keys()].some(key => !allowed.has(key)) || (historical ? retained === null || expected !== null || selectedHistoricalRevision !== null && Number(retained) !== selectedHistoricalRevision : expected === null || retained !== null || Number(expected) !== record.revision)) throw new Error('The complete folder does not match this saved selection. Reopen and check the handoff.');
      }
      const path = `${url.pathname}${url.search}`;
      const blob = packet ? await readPreparedFolder(await api.downloadResponse(path, { signal: controller.signal }), controller.signal, context.fingerprint, (received, total) => { if (mounted.current && binding === generation.current && !controller.signal.aborted) setPacketProgress({ href, received, total }); }) : await api.download(path);
      if (controller.signal.aborted) throw cancelledDownload();
      if (!mounted.current || binding !== generation.current) throw new Error('The selected handoff changed before this download completed. Reopen it before trying again.');
      const objectUrl = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = objectUrl; const format = url.searchParams.get('format'); const extension = packet ? '.zip' : format && ['pdf', 'csv', 'json', 'xlsx', 'geojson', 'kml'].includes(format) ? `.${format}` : ''; const filename = label.replace(/[^a-zA-Z0-9._ -]/g, '') || 'farm-records'; link.download = extension && !filename.toLowerCase().endsWith(extension) ? `${filename}${extension}` : filename; link.click(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      if (packet) setPacketNotice('The complete folder is ready to save in your browser. Nothing was sent.');
    } catch (failure) { if (mounted.current) { if (folderRequested && controller.signal.aborted) setPacketNotice('Folder download cancelled. Nothing was sent.'); else setHandoffError(errorMessage(failure)); } }
    finally { controller.abort(); if (downloadRequest.current === controller) downloadRequest.current = null; if (mounted.current) { setBusy(''); setPacketProgress(null); } }
  }
  if (!record) return <><PageHeader title="Paperwork case" /><Link to="/app/cases">All paperwork cases</Link>{error ? <Notice kind="error">{error}<Button onClick={() => setRefresh(value => value + 1)}>Retry this case</Button></Notice> : <p role="status">Opening the saved case…</p>}</>;
  const data = record.data;
  const focused = data.job_type === 'correction' && (data as CaseData & { focused_review_required?: boolean }).focused_review_required === true;
  return <><PageHeader title={data.title} description={`${jobTitle(data.job_type)} · ${data.reporting_year}`} action={<Button variant="secondary" disabled={loading || !!busy} onClick={() => { invalidate(); setRefresh(value => value + 1); }}>Reload saved case</Button>} /><Link to={`/app/cases?farm_id=${data.farm_id}`}>All cases for this farm</Link>{loading && <p role="status">Loading the latest saved version. Your private entries are retained.</p>}{error && <Notice kind="error">{error} Your private form entries are retained. Reload before retrying a stale action.</Notice>}{message && <Notice kind="success">{message}</Notice>}
    <section className="card"><h2>Where this case stands</h2><p><strong>{caseStatusLabel[data.status]}</strong></p><Notice>{data.external_status_notice || 'Sending, receipts and acceptance are recorded by a person. They are not verified with an authority.'}</Notice><dl className="detail-grid"><div><dt>Recorded deadline</dt><dd>{data.deadline || 'No deadline recorded'}</dd></div><div><dt>Original reference</dt><dd>{data.original_reference || 'Not recorded'}</dd></div><div><dt>Original sending date supplied</dt><dd>{data.original_submitted_at || 'Not recorded'}</dd></div></dl><p>{data.reason}</p><details><summary>Saved version details</summary><p>Case identity: {record.id} · revision {record.revision}</p></details></section>
    {data.job_type === 'correction' && <section className="card"><h2>Work through this correction</h2><p>Keep the original, explain the change, check the date guidance and read each saved answer before the final review below.</p><Link className="button button-primary" to={`/app/cases/${record.id}/correction`}>Continue the guided correction</Link></section>}
    {focused && !advanced ? <section className="card"><h2>Saved case details</h2><p>{data.reason || 'Explain what needs correcting in the guided steps.'}</p><p>The full case details remain available. Saving changes requires the appropriate permission and a new check of the answers and sources.</p>{!canWrite && <Notice>Your current permission is read-only. You can inspect the sources and history, but cannot change or review this case.</Notice>}<Button variant="secondary" onClick={() => setAdvanced(true)}>{canWrite ? 'Show all editable case details' : 'Show all saved case details'}</Button></section> : canWrite && editableCase(record) ? <CaseEditor key={`case-editor:${record.id}:${record.revision}`} record={record} views={checks?.references} onSaved={next => { setDirty(false); saved(next); }} onDirty={value => { setDirty(value); if (value) invalidate(); }} onSourcesChanged={invalidate} /> : <section className="card"><h2>Selected records</h2><ReferencePicker disabled farmId={data.farm_id} references={data.references || []} views={checks?.references} onChange={() => undefined} />{!canWrite ? <Notice>Your current permission is read-only. You can inspect the sources and history, but cannot change or review this case.</Notice> : <p>These reviewed records are kept for this step. Reopen preparation to change them; earlier sending records remain retained.</p>}</section>}
    {focused ? <details className="paper-section"><summary>Preparation items and supporting documents</summary><CaseItems record={record} canWrite={canWrite} onSaved={saved} /></details> : <CaseItems record={record} canWrite={canWrite} onSaved={saved} />}
    <section className="paper-section" id="case-checks"><h2>Check this case before sending</h2><p>The check uses your saved farm details and the selected records. It does not establish that every legal requirement has been met.</p>{dirty && <Notice kind="warning">Your private details have changes. Save them before reviewing a sending version.</Notice>}<Button loading={checkLoading} disabled={!!busy || loading} onClick={() => void check()}>Check the saved case</Button>{checkError && <Notice kind="error">{checkError}</Notice>}
      {checks && <><p>{checks.next_action}</p><Notice kind={checks.can_review ? 'success' : 'warning'}>{checks.notice}</Notice><ul>{checks.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}{internal(issue.href) && <> <Link to={issue.href!}>Open the record to check</Link></>}</li>)}</ul>
        <ul>{checks.references.map(reference => <li key={referenceKey(reference)}>{reference.title || referenceKinds.find(item => item.value === reference.kind)?.label} · {reference.current ? 'Current saved version' : 'Missing or changed'} <Link to={reference.kind === 'field_change_proposals' ? referenceHref(reference, data.farm_id) : internal(reference.href) ? reference.href! : referenceHref(reference, data.farm_id)}>Open source</Link><details><summary>Saved version details</summary><p>Source identity: {reference.id}</p><p>Selected revision {reference.revision}; current revision {reference.current_revision ?? 'unavailable'}</p></details></li>)}</ul>
        <details><summary>Saved version details</summary><p className="muted">Review fingerprint: <span style={{ overflowWrap: 'anywhere' }}>{checks.fingerprint}</span></p><p>Case revision {checks.case_revision}</p></details>
        {canWrite && editableCase(record) && <><p>The folder includes documents you selected here, documents attached to completed items, and attachments selected in your approved reports. Other private source files stay in your workspace.</p><label className="check-row"><input type="checkbox" checked={ack} disabled={!checks.can_review || dirty || checks.case_revision !== record.revision} onChange={event => setAck(event.target.checked)} />I checked these saved records and their sources. I understand that this review does not send anything.</label><Button loading={busy === 'review'} disabled={!ack || !checks.can_review || dirty || checks.case_revision !== record.revision} onClick={() => void review()}>Review this version for sending</Button></>}
      </>}
      <p>National requirements may not be fully covered here. Follow the actual notice and authority instructions; ask an adviser when the check cannot establish what is needed.</p>
    </section>
    <section className="card"><h2>Your next sending step</h2><p>{data.status === 'ready_to_send' ? 'Open the handoff, take the selected records to the official route yourself, then record the actual sending details.' : ['sent', 'receipt_saved', 'accepted_recorded'].includes(data.status) ? 'You can reopen the retained handoff and record an actual response below. A receipt does not by itself mean acceptance.' : 'Finish the records and open items, then check and review this case. Nothing will be sent automatically.'}</p><Button variant="secondary" loading={busy === 'handoff'} disabled={dirty || loading || !!busy || !['ready_to_send', 'sent', 'receipt_saved', 'accepted_recorded', 'needs_changes'].includes(data.status)} onClick={() => void openHandoff()}>Open handoff and downloads</Button>{handoffError && <Notice kind="error">{handoffError}</Notice>}</section>
    {packetNotice && <Notice>{packetNotice}</Notice>}
    {handoff && <Handoff handoff={handoff} onDownload={(href, label) => void download(href, label, { fingerprint: handoff.reference_fingerprint, origin: handoff.origin })} downloading={busy === 'download'} transfer={packetProgress} onCancel={cancelFolder} />}
    {canWrite && <EventForm key={`case-event:${record.id}:${record.revision}`} record={record} onSaved={next => { setDirty(false); saved(next); }} />}
    <EventHistory caseId={record.id} farmId={data.farm_id} refresh={eventsRefresh} onDownload={(href, label, eventId, eventRevision, fingerprint) => void download(href, label, { fingerprint, eventId, eventRevision, origin: 'sealed_sent_bundle' })} downloading={busy === 'download'} transfer={packetProgress} onCancel={cancelFolder} />
  </>;
}
