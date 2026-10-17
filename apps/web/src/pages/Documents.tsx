import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { Pack, Page, RecordItem } from '../types';

type Data = Record<string, unknown>;
type Destination = '' | 'requests' | 'purchases' | 'sales' | 'operations' | 'tasks' | 'facts';
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const words = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const display = (value: unknown) => value === undefined || value === null || value === '' ? 'Not recorded' : typeof value === 'string' ? value : JSON.stringify(value);
const message = (error: unknown) => error instanceof Error ? error.message : 'This could not be saved. Your entries are still here; please try again.';
const sampleName = (value: string) => value.replace(/^fictional(?:\s+(?:example|sample))?\s*[—–:-]?\s+/i, '');
const readableLabel = (value: string) => value.replaceAll('_', ' ').replaceAll('.', ' ').replace(/^./, letter => letter.toUpperCase());
const readable = (value: unknown): string => value === undefined || value === null ? 'Not recorded' : value === '' ? 'Blank entry' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : Array.isArray(value) ? value.length ? value.map(readable).join('; ') : 'No entries' : typeof value === 'object' ? Object.entries(value).map(([key, answer]) => `${readableLabel(key)}: ${readable(answer)}`).join(' · ') || 'No details supplied' : String(value);
const documentTypeLabel = (value: string) => ({ letter: 'Letter or notice', receipt: 'Receipt or invoice', notebook: 'Note or work record', unknown: 'Type undecided' } as Record<string, string>)[value] ?? readableLabel(value);
const title = (item: RecordItem) => sampleName(words(item.data.title, words(item.data.filename, 'Untitled document')));
const countries = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ');
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const purposeFor = (purpose: string): Destination => ['letter', 'inspection', 'request', 'requests'].includes(purpose) ? 'requests' : ['purchase', 'purchases'].includes(purpose) ? 'purchases' : ['sale', 'sales'].includes(purpose) ? 'sales' : ['notebook', 'operation', 'operations'].includes(purpose) ? 'operations' : ['task', 'tasks'].includes(purpose) ? 'tasks' : '';
const typeFor = (purpose: string) => purposeFor(purpose) === 'requests' ? 'letter' : ['receipt', 'invoice', 'sale', 'sales', 'purchase', 'purchases'].includes(purpose) ? 'receipt' : ['operations', 'tasks'].includes(purposeFor(purpose)) ? 'notebook' : 'unknown';
const kindLabel = (kind: string) => ({ purchases: 'purchase', sales: 'sale', operations: 'work record', tasks: 'task', facts: 'farm detail', requests: 'request' } as Record<string, string>)[kind] ?? 'record';
const usableSuggestion = (key: string, destination: Destination) => destination === 'facts' ? key !== 'addressee_text' : ({ requests: ['title', 'recipient', 'deadline_text', 'reporting_period_text', 'requirement_text', 'date_text'], purchases: ['title', 'merchant', 'reference', 'total_text', 'tax_text', 'tax_rate_text', 'quantity_text', 'currency_text', 'date_text', 'unit_text'], sales: ['title', 'buyer', 'reference', 'total_text', 'tax_text', 'tax_rate_text', 'quantity_text', 'currency_text', 'date_text', 'unit_text'], operations: ['title', 'date_text', 'operation_type', 'product', 'parcel', 'quantity_text', 'unit_text', 'hours_text'], tasks: ['title', 'deadline_text', 'requirement_text'], facts: [], '': [] } as Record<Destination, string[]>)[destination].includes(key);

function FarmChoice({ value, onChange, farms, optional = false, disabled = false }: { value: string; onChange: (value: string) => void; farms: RecordItem[]; optional?: boolean; disabled?: boolean }) {
  return <Field label={optional ? 'Which farm? (you can choose later)' : 'Which farm is this for?'}><select value={value} onChange={event => onChange(event.target.value)} required={!optional} disabled={disabled}><option value="">{optional ? 'Choose later' : 'Choose a farm'}</option>{farms.map(farm => <option key={farm.id} value={farm.id}>{sampleName(words(farm.data.name, 'Unnamed farm'))}</option>)}</select></Field>;
}

async function saveOriginal(id: string, filename: string) {
  const blob = await api.download(`/documents/${id}/file`);
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export function DocumentsPage() {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const farms = useRecords('farms');
  const requests = useRecords('requests');
  const { session } = useSession();
  const canWrite = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  const draft = usePrivateDraft('documents/new', { note: '', noteTitle: '', farmId: query.get('farm_id') || '', documentType: typeFor(query.get('purpose') || '') });
  const [mode, setMode] = useState<'file' | 'note'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [items, setItems] = useState<RecordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterFarm, setFilterFarm] = useState(query.get('farm_id') || '');
  const [filterType, setFilterType] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [collectionRequest, setCollectionRequest] = useState('');
  const listRequest = useRef(0);
  const farmId = draft.value.farmId;
  const documentType = draft.value.documentType;
  const change = (key: keyof typeof draft.value, value: string) => draft.setValue(previous => ({ ...previous, [key]: value }));
  useEffect(() => { if (!draft.ready) return; if (query.get('farm_id')) change('farmId', query.get('farm_id')!); if (query.get('purpose')) change('documentType', typeFor(query.get('purpose')!)); }, [draft.ready, query.toString()]);

  async function reload() {
    const sequence = ++listRequest.current; setLoading(true);
    const parameters = new URLSearchParams({ limit: '50', offset: String(offset), q: search });
    if (filterFarm) parameters.set('farm_id', filterFarm);
    if (filterType) parameters.set('document_type', filterType);
    try { const page = await api.get<Page<RecordItem>>(`/documents?${parameters}`); if (sequence === listRequest.current) { setItems(page.items); setTotal(page.total); setError(''); } }
    catch (cause) { if (sequence === listRequest.current) setError(message(cause)); }
    finally { if (sequence === listRequest.current) setLoading(false); }
  }
  useEffect(() => { const timer = window.setTimeout(() => void reload(), search ? 250 : 0); return () => { window.clearTimeout(timer); listRequest.current += 1; }; }, [search, offset, filterFarm, filterType]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !draft.ready) return;
    const chosen = mode === 'note' ? new File([draft.value.note], `${draft.value.noteTitle.trim() || 'Farm note'}.txt`, { type: 'text/plain' }) : file;
    if (!chosen || !chosen.size) { setError('Choose a file or write the note first.'); return; }
    if (chosen.size > 12 * 1024 * 1024) { setError('Choose a file smaller than 12 MiB. Split a large PDF into smaller documents.'); return; }
    const form = new FormData(); form.append('file', chosen); if (farmId) form.append('farm_id', farmId);
    setBusy('Saving the original…'); setError('');
    try {
      let saved = await api.upload<RecordItem & { duplicate?: boolean }>('/documents', form);
      let processingMessage = saved.duplicate ? 'This original was already saved. You are opening the existing document.' : '';
      if (!saved.duplicate) {
        setBusy('Original saved. Reading the document…');
        try { saved = await api.post<RecordItem>(`/documents/${saved.id}/extract`, { expected_revision: saved.revision, document_type: mode === 'note' ? 'notebook' : documentType }); }
        catch (cause) { processingMessage = `The original is saved. ${message(cause)} You can enter the text yourself.`; }
      }
      await draft.clear();
      const parameters = new URLSearchParams(); if (farmId) parameters.set('farm_id', farmId);
      const requestedPurpose = query.get('purpose') ?? '';
      const purpose = mode === 'note' ? 'notebook' : ['sale', 'sales', 'purchase', 'purchases'].includes(requestedPurpose) ? requestedPurpose : documentType; if (purpose !== 'unknown') parameters.set('purpose', purpose);
      navigate(`/app/documents/${saved.id}${parameters.size ? `?${parameters}` : ''}`, { state: { documentNotice: processingMessage } });
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(''); }
  }

  async function collect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const request = requests.items.find(item => item.id === collectionRequest);
    if (!request || !selected.length || busy) return;
    setBusy('Adding the selected documents…'); setError('');
    try {
      await api.post('/documents/collection', { request_id: request.id, expected_revision: request.revision, document_ids: selected });
      setNotice(`The selected documents are attached to “${words(request.data.title, 'the request')}”. Review the response before choosing anything to send.`);
      setSelected([]); await Promise.all([requests.reload(), reload()]);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(''); }
  }

  return <>
    <PageHeader title="Documents" description="Keep a letter, receipt, notebook page or photo. Read it once and save the useful details." />
    {error && <Notice kind="error">{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}
    {!canWrite && <Notice>You can read these documents. Ask the farm owner for permission to add documents or change a request.</Notice>}
    <section className="paper-section" aria-labelledby="add-document">
      <h2 id="add-document">What would you like to add?</h2>
      <div className="actions"><Button variant={mode === 'file' ? 'primary' : 'secondary'} onClick={() => setMode('file')} disabled={!!busy}>A file or photo</Button><Button variant={mode === 'note' ? 'primary' : 'secondary'} onClick={() => setMode('note')} disabled={!!busy}>Write a note</Button></div>
      <form onSubmit={upload} className="form-grid"><fieldset disabled={!!busy || !draft.ready || !canWrite} className="draft-fields">
        {mode === 'file' ? <>
          <Field label="Choose a PDF, photo or text file" hint="PDF, PNG, JPEG or UTF-8 text; up to 12 MiB and 25 pages."><input type="file" accept="application/pdf,image/png,image/jpeg,text/plain,.pdf,.png,.jpg,.jpeg,.txt" required={!file} onChange={event => setFile(event.target.files?.[0] ?? null)} /></Field>
          <Field label="Or take a photo" hint="On a phone, this opens the camera when supported."><input type="file" accept="image/jpeg,image/png" capture="environment" onChange={event => setFile(event.target.files?.[0] ?? null)} /></Field>
          {file && <p role="status">Selected: {file.name}</p>}
          <Field label="What is it?"><select value={documentType} onChange={event => change('documentType', event.target.value)}><option value="unknown">I will choose after reading it</option><option value="letter">A letter or inspection notice</option><option value="receipt">A receipt or invoice</option><option value="notebook">A notebook page or work record</option></select></Field>
        </> : <><Field label="Name this note"><input value={draft.value.noteTitle} onChange={event => change('noteTitle', event.target.value)} maxLength={160} placeholder="For example, work in the north field" /></Field><Field label="Your note" hint="Include the date, quantity and unit when you know them. Leave uncertain details unresolved."><textarea required rows={7} maxLength={250000} value={draft.value.note} onChange={event => change('note', event.target.value)} /></Field></>}
        <FarmChoice farms={farms.items} value={farmId} onChange={entry => change('farmId', entry)} optional />
        <Button type="submit" disabled={mode === 'file' ? !file : !draft.value.note.trim()}>{busy || 'Save and read document'}</Button>
      </fieldset></form>
      <p className="muted">Your original stays private and unchanged. Reading it only suggests details for you to check.</p>
      {draft.error && <Notice kind="warning">{draft.error}</Notice>}{farms.error && <Notice kind="warning">Farm choices could not load. You can choose a farm later.</Notice>}
    </section>
    <section className="paper-section" aria-labelledby="document-library">
      <div className="section-heading"><h2 id="document-library">Find your documents</h2><Button variant="secondary" onClick={() => void reload()} disabled={loading}>Refresh</Button></div>
      <div className="form-grid"><Field label="Search names, notes and readable text"><input type="search" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} placeholder="For example, inspection or supplier name" /></Field><Field label="Farm"><select value={filterFarm} onChange={event => { setFilterFarm(event.target.value); setOffset(0); }}><option value="">All your farms</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{sampleName(words(farm.data.name))}</option>)}</select></Field><Field label="Document type"><select value={filterType} onChange={event => { setFilterType(event.target.value); setOffset(0); }}><option value="">All types</option><option value="letter">Letters and notices</option><option value="receipt">Receipts and invoices</option><option value="notebook">Notes and work records</option><option value="unknown">Type undecided</option></select></Field></div>
      <p className="muted">For an inspection, select only the documents that answer the request.</p>
      {loading ? <p role="status">Loading documents…</p> : items.length ? <ul className="record-list">{items.map(item => <li key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}><label className="check-row" style={{ padding: 12 }}><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(identifier => identifier !== item.id))} /><span className="sr-only">Select {title(item)}</span></label><Link to={`/app/documents/${item.id}`} style={{ flex: 1 }}><strong>{title(item)}</strong><span className="muted">{documentTypeLabel(words(item.data.document_type, words(object(item.data.extraction).document_type, 'unknown')))} · {new Date(item.created_at).toLocaleDateString()}</span></Link></li>)}</ul> : <p className="empty-state">{search || filterFarm || filterType ? 'No documents match these choices.' : 'Add your first letter, receipt, photo or note above.'}</p>}
      {total > 50 && <nav className="actions" aria-label="Document pages"><Button variant="secondary" disabled={loading || !offset} onClick={() => setOffset(previous => Math.max(0, previous - 50))}>Previous</Button><span>{offset + 1}–{Math.min(offset + 50, total)} of {total}</span><Button variant="secondary" disabled={loading || offset + 50 >= total} onClick={() => setOffset(previous => previous + 50)}>More documents</Button></nav>}
      {!!selected.length && <form onSubmit={collect} className="form-grid"><h3>{selected.length} selected</h3><Field label="Attach these to which request?"><select required value={collectionRequest} onChange={event => setCollectionRequest(event.target.value)}><option value="">Choose a request or inspection</option>{requests.items.filter(item => ['draft', 'review', 'waiting'].includes(words(item.data.status, 'draft')) && (!filterFarm || item.data.farm_id === filterFarm)).map(item => <option key={item.id} value={item.id}>{words(item.data.title, 'Untitled request')}</option>)}</select></Field><div className="actions"><Button type="submit" disabled={!!busy || !collectionRequest || !canWrite}>Attach selected documents</Button><Button variant="ghost" onClick={() => setSelected([])}>Clear selection</Button></div><p className="muted">The documents stay in your workspace. Choose the response contents before sharing or downloading a report.</p></form>}
      {requests.error && <Notice kind="warning">Requests could not load. Refresh before collecting documents.</Notice>}
    </section>
  </>;
}

interface ReviewDraft {
  farmId: string; destination: Destination; documentType: string; manualText: string; requestTitle: string; recipient: string; country: string; year: string; deadline: string; requirements: string; packId: string;
  recordTitle: string; date: string; printedDate: string; printedDeadline: string; printedPeriod: string; amount: string; currency: string; quantity: string; unit: string; supplier: string; buyer: string; invoiceNumber: string; category: string; taxAmount: string; taxRate: string; credit: boolean;
  operationType: string; product: string; parcel: string; hours: string; notes: string; factKey: string; factValue: string; factValueType: string; temporalBasis: string; period: string;
  suggestionEdits: Record<string, string>; selectedProposals: string[]; unusedProposals: string[];
  reviewExplanation: string; financialDirectionChecked: boolean;
}
function initialReview(farmId: string, purpose: string): ReviewDraft {
  return { farmId, destination: purposeFor(purpose), documentType: typeFor(purpose), manualText: '', requestTitle: '', recipient: '', country: '', year: '', deadline: '', requirements: '', packId: '', recordTitle: '', date: '', printedDate: '', printedDeadline: '', printedPeriod: '', amount: '', currency: '', quantity: '', unit: '', supplier: '', buyer: '', invoiceNumber: '', category: '', taxAmount: '', taxRate: '', credit: false, operationType: '', product: '', parcel: '', hours: '', notes: '', factKey: '', factValue: '', factValueType: 'text', temporalBasis: 'calendar_date', period: '', suggestionEdits: {}, selectedProposals: [], unusedProposals: [], reviewExplanation: '', financialDirectionChecked: ['purchases', 'sales'].includes(purposeFor(purpose)) };
}
function numeric(value: string, label: string): number | null {
  if (!value.trim()) return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(value.trim()) || !Number.isFinite(Number(value))) throw new Error(`${label}: enter the number without currency or thousands separators, using a dot for decimals. Check the printed value first.`);
  return Number(value);
}

function TaskEdit({ record, onSaved }: { record: RecordItem; onSaved: (record: RecordItem) => void }) {
  const draft = usePrivateDraft(`document-task/${record.id}/edit`, { title: words(record.data.title), description: words(record.data.description), due_date: words(record.data.due_date), expected_revision: record.revision });
  const [latest, setLatest] = useState<RecordItem | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const change = (key: 'title' | 'description' | 'due_date', value: string) => draft.setValue(previous => ({ ...previous, [key]: value }));
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try { const saved = await api.patch<RecordItem>(`/tasks/${record.id}`, { expected_revision: draft.value.expected_revision, data: { title: draft.value.title, description: draft.value.description, due_date: draft.value.due_date || null } }); draft.setValue(previous => ({ ...previous, expected_revision: saved.revision })); onSaved(saved); }
    catch (cause) {
      setError(message(cause));
      if (cause instanceof ApiError && cause.status === 409) { try { setLatest(await api.get<RecordItem>(`/tasks/${record.id}`)); } catch (failure) { setError(message(failure)); } }
    } finally { setBusy(false); }
  }
  return <details><summary>Change this task</summary>{error && <Notice kind="error">{error}</Notice>}{draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {latest && <Notice kind="warning"><p>A newer version is saved: {words(latest.data.title)}. Due: {display(latest.data.due_date)}.</p><p>{words(latest.data.description)}</p><p>Your entries are still in the form. Compare them before saving.</p><Button variant="secondary" onClick={() => { draft.setValue(previous => ({ ...previous, expected_revision: latest.revision })); setLatest(null); setError(''); }}>I compared these details; keep my entered changes</Button></Notice>}
    <form onSubmit={save} className="form-grid"><fieldset className="draft-fields" disabled={busy || !draft.ready || !!latest}><Field label="What needs doing?"><input required maxLength={300} value={draft.value.title} onChange={event => change('title', event.target.value)} /></Field><Field label="What should the person doing this know?"><textarea rows={3} maxLength={4000} value={draft.value.description} onChange={event => change('description', event.target.value)} /></Field><Field label="Due date (if known)"><input type="date" value={draft.value.due_date} onChange={event => change('due_date', event.target.value)} /></Field><Button type="submit">{busy ? 'Saving changes…' : 'Save task changes'}</Button></fieldset></form>
  </details>;
}

export function DocumentDetailPage() {
  const { id } = useParams();
  const [query] = useSearchParams();
  const location = useLocation();
  const farms = useRecords('farms');
  const { session } = useSession();
  const canWrite = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  const canReview = canWrite && session?.workspace.role !== 'worker';
  const defaults = initialReview(query.get('farm_id') || '', query.get('purpose') || '');
  const draft = usePrivateDraft<ReviewDraft>(`document/${id ?? 'unknown'}/review`, defaults);
  const value: ReviewDraft = { ...defaults, ...draft.value };
  const [document, setDocument] = useState<RecordItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(words(object(location.state).documentNotice));
  const [requestId, setRequestId] = useState('');
  const [savedRecord, setSavedRecord] = useState<RecordItem | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [packError, setPackError] = useState('');
  const [issues, setIssues] = useState<Data[]>([]);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [checkToken, setCheckToken] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const generation = useRef(0);
  const retryKeys = useRef({ request: crypto.randomUUID(), record: crypto.randomUUID(), review: crypto.randomUUID() });

  function change<K extends keyof ReviewDraft>(key: K, entry: ReviewDraft[K]) {
    draft.setValue(previous => ({ ...defaults, ...previous, [key]: entry }));
    setIssues([]); setAcknowledged([]); setCheckToken(null);
  }
  function chooseDestination(destination: Destination) {
    change('destination', destination);
    change('financialDirectionChecked', ['purchases', 'sales'].includes(destination));
    change('selectedProposals', []);
    if (destination === 'sales' || value.destination === 'sales') change('category', '');
    retryKeys.current.record = crypto.randomUUID();
    setSavedRecord(null); setRequestId('');
  }
  async function load() {
    if (!id) return; const sequence = ++generation.current; setLoading(true);
    try { const item = await api.get<RecordItem>(`/documents/${id}`); if (sequence === generation.current) { setDocument(item); setError(''); } }
    catch (cause) { if (sequence === generation.current) setError(message(cause)); }
    finally { if (sequence === generation.current) setLoading(false); }
  }
  useEffect(() => { setDocument(null); setSavedRecord(null); setRequestId(''); setPreview(''); void load(); return () => { generation.current += 1; }; }, [id]);
  useEffect(() => {
    const taskId = query.get('task_id');
    if (!document || !taskId) return;
    let active = true;
    api.get<RecordItem>(`/tasks/${encodeURIComponent(taskId)}`).then(task => {
      if (!active) return;
      if (task.data.document_id === document.id) setSavedRecord(task);
      else setError('This task is not attached to the document you opened. Open it from your farm task list.');
    }).catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [document?.id, query.get('task_id')]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    if (!savedRecord || !query.get('task_id')) return;
    const frame = window.requestAnimationFrame(() => window.document.getElementById('saved-record')?.scrollIntoView({ block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [savedRecord?.id, query.get('task_id')]);
  useEffect(() => {
    if (!draft.ready || !document) return;
    draft.setValue(previous => {
      const documentType = previous.documentType === 'unknown' ? words(object(document.data.extraction).document_type, 'unknown') : previous.documentType;
      return { ...defaults, ...previous, farmId: document.data.farm_id ? words(document.data.farm_id) : previous.farmId, documentType, destination: previous.destination || purposeFor(documentType) };
    });
  }, [draft.ready, document?.id]);
  useEffect(() => {
    const farm = farms.items.find(item => item.id === value.farmId);
    if (!draft.ready || !farm) return;
    draft.setValue(previous => ({ ...defaults, ...previous, country: previous.country || words(farm.data.country), year: previous.year || (farm.data.reporting_year ? String(farm.data.reporting_year) : '') }));
  }, [draft.ready, value.farmId, farms.items]);
  useEffect(() => {
    let active = true; setPacks([]); setPackError('');
    if (value.country.length !== 2 || !/^\d{4}$/.test(value.year)) return;
    api.get<Page<Pack>>(`/packs?country=${encodeURIComponent(value.country)}&year=${encodeURIComponent(value.year)}`).then(result => { if (active) setPacks(result.items); }).catch(cause => { if (active) setPackError(message(cause)); });
    return () => { active = false; };
  }, [value.country, value.year]);

  async function extract() {
    if (!document || busy) return;
    setBusy('extract'); setError(''); setNotice('');
    try {
      const result = await api.post<RecordItem>(`/documents/${document.id}/extract`, { expected_revision: document.revision, document_type: value.documentType, ...(value.manualText.trim() ? { text: value.manualText } : {}) });
      setDocument(result);
      setNotice(object(result.data.extraction).status === 'proposed' ? 'The readable details are below. Choose what you want to keep, then check each value you use.' : 'The original is saved. Add the text you can read, or enter the details yourself.');
      draft.setValue(previous => ({ ...defaults, ...previous, selectedProposals: [], unusedProposals: [], suggestionEdits: {} }));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(''); }
  }
  function useSuggestion(proposal: Data, identifier: string) {
    const checked = value.suggestionEdits[identifier] ?? display(proposal.value);
    const key = words(proposal.key);
    const mappings: Record<string, keyof ReviewDraft> = { title: value.destination === 'requests' ? 'requestTitle' : 'recordTitle', merchant: 'supplier', buyer: 'buyer', reference: 'invoiceNumber', total_text: 'amount', tax_text: 'taxAmount', tax_rate_text: 'taxRate', quantity_text: 'quantity', currency_text: 'currency', date_text: 'printedDate', deadline_text: 'printedDeadline', reporting_period_text: 'printedPeriod', recipient: 'recipient', operation_type: 'operationType', product: 'product', parcel: 'parcel', unit_text: 'unit', hours_text: 'hours' };
    draft.setValue(previous => {
      const next = { ...defaults, ...previous, selectedProposals: Array.from(new Set([...(previous.selectedProposals ?? []), ...(proposal.id ? [identifier] : [])])), unusedProposals: (previous.unusedProposals ?? []).filter(item => item !== identifier) };
      if (key === 'requirement_text' && value.destination === 'tasks') next.notes = [next.notes, checked].filter(Boolean).join('\n');
      else if (key === 'requirement_text') next.requirements = [next.requirements, checked].filter(Boolean).join('\n');
      else if (value.destination === 'facts' && !['title', 'date_text', 'reporting_period_text'].includes(key)) next.factValue = checked;
      else if (mappings[key]) Object.assign(next, { [mappings[key]]: checked });
      return next;
    });
    setNotice(['date_text', 'deadline_text', 'reporting_period_text'].includes(key) ? 'The printed date or period is beside the form. Choose its meaning and enter the applicable date yourself.' : 'The checked value is in the form below. Numbers still need their unit or currency before saving.');
    setIssues([]); setAcknowledged([]); setCheckToken(null);
  }
  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!document || busy) return;
    setBusy('save'); setError('');
    try {
      const result = await api.post<RecordItem>(`/documents/${document.id}/request`, { expected_revision: document.revision, data: { farm_id: value.farmId, title: value.requestTitle, recipient: value.recipient, country: value.country, reporting_year: Number(value.year), deadline: value.deadline || null, pack_id: value.packId, requirements: value.requirements.split('\n').map(line => line.trim()).filter(Boolean).map((label, index) => ({ key: `requested_${index + 1}`, label, required: true })), status: 'draft' } }, { idempotencyKey: retryKeys.current.request });
      setRequestId(result.id); setNotice('The request is saved with this document attached. Open it to answer what is missing and choose a response.'); await load();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(''); }
  }
  async function saveRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!document || !value.destination || value.destination === 'requests' || busy) return;
    setBusy('save'); setError('');
    try {
      if (['purchases', 'sales'].includes(value.destination) && !value.financialDirectionChecked) throw new Error('Confirm whether this farm bought something or sold something before saving the invoice.');
      const common: Data = { farm_id: value.farmId }; let data: Data;
      if (value.destination === 'tasks') data = { ...common, title: value.recordTitle, description: value.notes, due_date: value.deadline || null, status: 'open' };
      else if (value.destination === 'facts') {
        let factValue: unknown = value.factValue;
        if (value.factValueType === 'number') factValue = numeric(value.factValue, 'Farm detail');
        if (value.factValueType === 'boolean') { if (!['true', 'false'].includes(value.factValue.toLowerCase())) throw new Error('Enter true or false for a yes/no farm detail.'); factValue = value.factValue.toLowerCase() === 'true'; }
        data = { ...common, key: value.factKey, label: value.recordTitle, value: factValue, unit: value.unit || null, temporal_basis: value.temporalBasis, period: value.temporalBasis === 'static' ? null : value.temporalBasis === 'calendar_date' ? value.date || null : value.period || null, notes: value.notes };
      } else {
        data = { ...common, title: value.recordTitle, date: value.date || null, quantity: numeric(value.quantity, 'Quantity'), unit: value.unit || null, notes: value.notes, ...(value.date ? { temporal_basis: 'calendar_date', period: value.date } : {}) };
        if (value.destination === 'purchases' || value.destination === 'sales') Object.assign(data, { amount: numeric(value.amount, 'Total amount'), currency: value.currency.toUpperCase(), ...(value.destination === 'sales' ? { buyer: value.buyer } : { supplier: value.supplier }), invoice_number: value.invoiceNumber, category: value.category, tax_amount: numeric(value.taxAmount, 'Printed tax'), tax_rate: numeric(value.taxRate, 'Printed tax rate'), credit: value.credit });
        else Object.assign(data, { type: value.operationType, product: value.product, parcel: value.parcel, hours: numeric(value.hours, 'Work hours') });
      }
      const result = await api.post<RecordItem>(`/documents/${document.id}/records`, { expected_revision: document.revision, kind: value.destination, data, selected_proposal_ids: value.selectedProposals, acknowledged_issue_codes: acknowledged, check_token: checkToken }, { idempotencyKey: retryKeys.current.record });
      setSavedRecord(result); setIssues([]); setAcknowledged([]); setNotice(value.destination === 'tasks' ? 'The task is saved with its original document attached.' : `The ${kindLabel(value.destination)} is saved for review. Read back the saved details before confirming it.`); await load();
    } catch (cause) { setError(message(cause)); if (cause instanceof ApiError && Array.isArray(cause.details.issues)) { setIssues(cause.details.issues.map(object)); setCheckToken(words(cause.details.check_token) || null); } }
    finally { setBusy(''); }
  }
  async function confirmSaved() {
    if (!savedRecord || busy || !canReview) return;
    setBusy('confirm'); setError('');
    try { const result = await api.post<RecordItem>(`/${savedRecord.kind}/${savedRecord.id}/review`, { expected_revision: savedRecord.revision, decision: 'confirmed', note: value.reviewExplanation.trim() || 'Checked the saved values against the original document.' }, { idempotencyKey: retryKeys.current.review }); setSavedRecord(result); setNotice(`The ${kindLabel(result.kind)} is confirmed. It keeps its link to the original.`); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(''); }
  }
  async function changeTaskStatus() {
    if (!savedRecord || savedRecord.kind !== 'tasks' || busy || !canWrite) return;
    setBusy('task'); setError('');
    try {
      const status = savedRecord.data.status === 'done' ? 'open' : 'done';
      setSavedRecord(await api.patch<RecordItem>(`/tasks/${savedRecord.id}`, { expected_revision: savedRecord.revision, data: { status } }));
      setNotice(status === 'done' ? 'The task is marked done. Its document and history are retained.' : 'The task is open again.');
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(''); }
  }

  if (loading && !document) return <p role="status">Opening document…</p>;
  if (!document) return <><PageHeader title="Document unavailable" /><Notice kind="error">{error || 'This document could not be found in your workspace.'}</Notice><Link to="/app/documents">Back to documents</Link></>;
  if (!draft.ready) return <p role="status">Opening your private review draft…</p>;
  const extraction = object(document.data.extraction);
  const proposals = Array.isArray(extraction.fields) ? extraction.fields.map(object) : [];
  const selectedFarm = farms.items.find(item => item.id === value.farmId);
  const recordName = value.destination ? kindLabel(value.destination) : 'record';

  return <>
    <Link className="back-link" to="/app/documents">Back to documents</Link>
    <PageHeader title={title(document)} description="Read the original, check useful details, and choose where to keep them." />
    {document.data.farm_id && <div className="actions"><Link to={`/app/cases/new?${new URLSearchParams({ farm_id: String(document.data.farm_id), job_type: 'inspection', reference_kind: 'documents', reference_id: document.id, reference_revision: String(document.revision), reference_role: 'notice' })}`}>Prepare an inspection from this document</Link><Link to={`/app/cases/new?${new URLSearchParams({ farm_id: String(document.data.farm_id), job_type: 'correction', reference_kind: 'documents', reference_id: document.id, reference_revision: String(document.revision), reference_role: 'notice' })}`}>Work through a correction from this document</Link></div>}
    {!canWrite && <Notice>You can read this document. Ask the farm owner for permission to save or review new details.</Notice>}
    {error && <Notice kind="error">{error}{error.toLowerCase().includes('changed') && <p>Your entries are still here. <Button variant="secondary" disabled={!!busy} onClick={() => void load()}>Load the latest saved document</Button></p>}</Notice>}
    {notice && <Notice>{notice}{requestId && <> <Link to={`/app/paperwork/${requestId}`}>Open request</Link></>}</Notice>}
    {draft.error && <Notice kind="warning">{draft.error}</Notice>}
    <p className="muted" role="status">{draft.saving ? 'Saving your review draft on this device…' : draft.error ? 'Keep this page open until your changes are saved to the workspace.' : 'Your review draft is kept privately on this device.'}</p>
    <section className="paper-section" aria-labelledby="document-original">
      <h2 id="document-original">Keep the original beside you</h2>
      <div className="actions"><Button variant="secondary" disabled={!!busy} onClick={async () => { setBusy('download'); try { await saveOriginal(document.id, words(document.data.filename, title(document))); } catch (cause) { setError(message(cause)); } finally { setBusy(''); } }}>Download original</Button>
        {words(document.data.media_type).startsWith('image/') && <Button variant="secondary" disabled={!!busy} onClick={async () => { if (preview) { setPreview(''); return; } setBusy('preview'); try { const blob = await api.download(`/documents/${document.id}/file`); setPreview(URL.createObjectURL(new Blob([blob], { type: words(document.data.media_type) }))); } catch (cause) { setError(message(cause)); } finally { setBusy(''); } }}>{preview ? 'Hide photo' : 'Show photo'}</Button>}
      </div>
      {preview && <img src={preview} alt={`Original photo: ${title(document)}`} style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} />}
      <p>Printed dates can mean different things. A receipt total does not show that a product was applied to a field.</p>
      <Field label="What kind of document is this?"><select value={value.documentType} onChange={event => change('documentType', event.target.value)}><option value="unknown">I am not sure</option><option value="letter">A letter or inspection notice</option><option value="receipt">A receipt or invoice</option><option value="notebook">A notebook page or work note</option></select></Field>
      <Button onClick={() => void extract()} disabled={!!busy || !canWrite}>{busy === 'extract' ? 'Reading the document…' : proposals.length ? 'Read the document again' : 'Read useful details'}</Button>
      {!!extraction.failure && <Notice kind="warning">{words(object(extraction.failure).message, 'Reading was unavailable. Enter the text or details yourself.')}</Notice>}
      {Array.isArray(extraction.warnings) && extraction.warnings.map((warning, index) => <Notice key={index} kind="warning">{readable(warning)}</Notice>)}
      <details open={!!extraction.failure}><summary>Enter or correct the readable text yourself</summary><p>If a photo is unclear or reading is unavailable, type what you can read. Use a new line for each printed line. Leave unreadable words blank.</p><Field label="Text from the original"><textarea rows={7} maxLength={250000} value={value.manualText} onChange={event => change('manualText', event.target.value)} /></Field><Button disabled={!!busy || !value.manualText.trim() || !canWrite} onClick={() => void extract()}>Read this text</Button></details>
      {Array.isArray(extraction.pages) && extraction.pages.length > 0 && <details><summary>Read the extracted text by page</summary>{extraction.pages.map((entry, index) => { const page = object(entry); return <section key={index}><h3>Page {display(page.page)}</h3>{Array.isArray(page.lines) && <ol>{page.lines.map((line, lineIndex) => <li key={lineIndex} value={Number(object(line).line)} style={{ whiteSpace: 'pre-wrap' }}>{words(object(line).text) || ' '}</li>)}</ol>}</section>; })}</details>}
    </section>
    <section className="paper-section" aria-labelledby="document-purpose">
      <h2 id="document-purpose">What would you like to keep?</h2><p>Choose what this document tells you. You can return to save another kind of record later.</p>
      <Field label="Save as"><select value={value.destination} onChange={event => chooseDestination(event.target.value as Destination)}><option value="">Choose what you need</option><option value="requests">A request from a letter or inspection notice</option><option value="purchases">A purchase from a receipt or invoice</option><option value="sales">A sale or sales invoice</option><option value="operations">Work that actually happened on the farm</option><option value="tasks">Something that needs doing</option><option value="facts">A farm detail to reuse in reports</option></select></Field>
      {value.documentType === 'receipt' && !value.destination && <Notice>Did this farm buy something or sell something? Choose a purchase or a sale above. An invoice heading does not establish its direction.</Notice>}
      {value.destination === 'purchases' && <p>A purchase records what you bought. Record its use separately only when you know what happened, where and when.</p>}
      {value.destination === 'sales' && <p>A sale records what this farm sold, to the buyer you identify. Supplier names are never used as the buyer. Enter the actual sale date; an annual income total cannot establish an individual sale.</p>}
      {value.destination === 'operations' && value.documentType === 'receipt' && <Notice kind="warning">This is a receipt. It can support a purchase, but it does not establish that any work or application happened. Use a dated work note or your own checked record for that.</Notice>}
      <FarmChoice farms={farms.items} value={value.farmId} onChange={entry => change('farmId', entry)} disabled={!!document.data.farm_id} />
      {value.destination && <a href={value.destination === 'requests' ? '#request-review' : '#record-review'}>Go to the {kindLabel(value.destination)} form</a>}
      {farms.error && <Notice kind="error">Farm choices could not load. Refresh before saving.</Notice>}{!farms.loading && !farms.items.length && <Notice><Link to="/app/fields">Add your farm</Link> before saving these details.</Notice>}
    </section>
    <section className="paper-section" aria-labelledby="suggested-information">
      <h2 id="suggested-information">Check the suggested details</h2><p>Compare a value with its quoted line. Correct it if needed, then use only the details you want.</p>
      {proposals.length ? proposals.map((proposal, index) => {
        const identifier = words(proposal.id, `legacy-${index}`); const sources = Array.isArray(proposal.sources) ? proposal.sources.map(object) : []; const unused = value.unusedProposals.includes(identifier);
        return <section className="paper-section" key={identifier} aria-label={words(proposal.label, 'Suggested detail')}><h3>{words(proposal.label, words(proposal.key))}</h3>
          {sources.map((source, sourceIndex) => <blockquote key={sourceIndex}><p style={{ whiteSpace: 'pre-wrap' }}>{words(source.quote)}</p><cite>{source.source_kind === 'manual_transcription' ? 'Your transcription' : 'Text read from the original'}, page {display(source.page)}, line {display(source.line_start)}{source.line_end !== source.line_start ? `–${display(source.line_end)}` : ''}</cite></blockquote>)}
          <Field label="The value you can read"><input value={value.suggestionEdits[identifier] ?? display(proposal.value)} onChange={event => change('suggestionEdits', { ...value.suggestionEdits, [identifier]: event.target.value })} maxLength={4000} /></Field>
          <div className="actions"><Button variant="secondary" disabled={!usableSuggestion(words(proposal.key), value.destination) || !!busy || unused} onClick={() => useSuggestion(proposal, identifier)}>{value.selectedProposals.includes(identifier) ? 'Use this correction' : 'Use this checked value'}</Button><Button variant="ghost" disabled={!!busy} onClick={() => { change('unusedProposals', unused ? value.unusedProposals.filter(item => item !== identifier) : [...value.unusedProposals, identifier]); if (!unused) change('selectedProposals', value.selectedProposals.filter(item => item !== identifier)); }}>{unused ? 'Review this again' : 'Leave unused'}</Button></div>
          {unused && <p className="muted">Left unused.</p>}{value.selectedProposals.includes(identifier) && <p className="muted">Copied to your review form below. Check its meaning, date and unit there.</p>}
        </section>;
      }) : <Notice>No readable suggestions yet. You can enter the details below yourself.</Notice>}
      {Array.isArray(extraction.uncertain_fields) && extraction.uncertain_fields.length > 0 && <Notice kind="warning"><h3>What still needs checking?</h3><ul>{extraction.uncertain_fields.map((entry, index) => <li key={index}>{words(object(entry).reason, 'This detail is still uncertain.')}</li>)}</ul></Notice>}
    </section>
    {value.destination === 'requests' && <section className="paper-section" aria-labelledby="request-review"><h2 id="request-review">Make the request clear</h2><p>Start with what the letter asks for. Its printed date and its response deadline can be different.</p>
      <form className="form-grid" onSubmit={createRequest}><fieldset disabled={!!busy || !!requestId || !canWrite} className="draft-fields">
        <Field label="What have you been asked to provide or correct?"><input required maxLength={240} value={value.requestTitle} onChange={event => change('requestTitle', event.target.value)} placeholder="For example, explain the field area in an inspection" /></Field>
        <Field label="Who will receive your answer?"><input required maxLength={240} value={value.recipient} onChange={event => change('recipient', event.target.value)} placeholder="Name of the authority, adviser or organisation" /></Field>
        <Field label="What exactly do they need? One item per line"><textarea rows={4} value={value.requirements} onChange={event => change('requirements', event.target.value)} placeholder="For example, receipts for the requested period" /></Field>
        <Field label="Country"><select required value={value.country} onChange={event => { change('country', event.target.value); change('packId', ''); }}><option value="">Choose the country</option>{countries.map(country => <option key={country} value={country}>{countryNames.of(country)}</option>)}</select></Field>
        <Field label="Which reporting year does the request concern?"><input required type="number" min={1900} max={2100} value={value.year} onChange={event => { change('year', event.target.value); change('packId', ''); }} /></Field>
        {value.printedPeriod && <Notice>Printed period: “{value.printedPeriod}”. Check which year the request concerns.</Notice>}
        <Field label="Response format"><select required value={value.packId} onChange={event => change('packId', event.target.value)}><option value="">Choose the response format</option>{packs.map(pack => <option key={pack.id} value={pack.id}>{pack.name || pack.title || pack.id}</option>)}</select></Field>
        {packError && <Notice kind="error">{packError}</Notice>}
        {value.printedDeadline && <Notice>Printed deadline: “{value.printedDeadline}”. Enter a date only after checking what it applies to.</Notice>}
        {value.printedDate && <p>Printed document date: “{value.printedDate}”. This has not been used as the response deadline.</p>}
        <Field label="Reply by (leave blank if uncertain)"><input type="date" value={value.deadline} onChange={event => change('deadline', event.target.value)} /></Field>
        <p>Read back: {value.requestTitle || 'The requested action is still missing'} for {selectedFarm ? words(selectedFarm.data.name) : 'a farm you still need to choose'}, sent to {value.recipient || 'a recipient you still need to enter'}. {value.deadline ? `Reply by ${value.deadline}.` : 'The response deadline is not confirmed.'}</p>
        <Button type="submit" disabled={!value.farmId || !value.packId}>{requestId ? 'Request saved' : busy === 'save' ? 'Saving request…' : 'Save this request with its letter'}</Button>
      </fieldset></form>
    </section>}
    {value.destination && value.destination !== 'requests' && <section className="paper-section" aria-labelledby="record-review"><h2 id="record-review">Check the {recordName}</h2>
      <form className="form-grid" onSubmit={saveRecord}><fieldset disabled={!!busy || !!savedRecord || !canWrite} className="draft-fields">
        <Field label={value.destination === 'tasks' ? 'What needs doing?' : value.destination === 'facts' ? 'What farm detail are you recording?' : 'Give this record a clear name'}><input required maxLength={300} value={value.recordTitle} onChange={event => change('recordTitle', event.target.value)} /></Field>
        {value.destination === 'tasks' ? <><Field label="Due date (if known)"><input type="date" value={value.deadline} onChange={event => change('deadline', event.target.value)} /></Field>{value.printedDeadline && <Notice>Printed date to check: “{value.printedDeadline}”.</Notice>}</> : <>
          {value.printedDate && <Notice>Printed date: “{value.printedDate}”. Choose the actual {value.destination === 'purchases' ? 'purchase' : value.destination === 'sales' ? 'sale' : 'record'} date; it has not been inferred.</Notice>}
          <Field label={value.destination === 'purchases' ? 'Purchase date (if known)' : value.destination === 'sales' ? 'Actual sale date' : 'When did this happen?'}><input type="date" required={value.destination === 'sales'} value={value.date} onChange={event => change('date', event.target.value)} /></Field>
          {value.destination === 'facts' ? <>
            <Field label="Detail name used in your reporting pack"><input required maxLength={300} value={value.factKey} onChange={event => change('factKey', event.target.value)} placeholder="For example, farm_area_ha" /></Field>
            <Field label="Kind of value"><select value={value.factValueType} onChange={event => change('factValueType', event.target.value)}><option value="text">Text</option><option value="number">A number</option><option value="boolean">Yes or no (true or false)</option></select></Field>
            <Field label="Value"><input required value={value.factValue} onChange={event => change('factValue', event.target.value)} /></Field>
            <Field label="When is this detail true?"><select value={value.temporalBasis} onChange={event => change('temporalBasis', event.target.value)}><option value="calendar_date">Observed on the date above</option><option value="campaign_year">For a particular campaign year</option><option value="static">A lasting detail, with no annual observation claimed</option></select></Field>
            {value.temporalBasis === 'campaign_year' && <Field label="Campaign year"><input required inputMode="numeric" pattern="[0-9]{4}" value={value.period} onChange={event => change('period', event.target.value)} /></Field>}
          </> : <Field label="Quantity (if readable)" hint="Use a dot for decimals; keep zero when the printed value is zero."><input inputMode="decimal" value={value.quantity} onChange={event => change('quantity', event.target.value)} /></Field>}
          <Field label="Unit (leave blank if unknown)" hint="For example, kg, L or ha. Do not guess an unreadable unit."><input maxLength={100} value={value.unit} onChange={event => change('unit', event.target.value)} /></Field>
          {(value.destination === 'purchases' || value.destination === 'sales') && <>
            <label className="check-row"><input required type="checkbox" checked={value.financialDirectionChecked} onChange={event => change('financialDirectionChecked', event.target.checked)} />I checked that this farm {value.destination === 'sales' ? 'sold what this invoice describes' : 'bought what this receipt or invoice describes'}.</label>
            {value.destination === 'sales' ? <Field label="Buyer" hint="Enter the customer named on the sale. Leave the draft open if the buyer is unclear."><input required maxLength={300} value={value.buyer} onChange={event => change('buyer', event.target.value)} /></Field> : <Field label="Supplier"><input maxLength={300} value={value.supplier} onChange={event => change('supplier', event.target.value)} /></Field>}
            <Field label="Invoice or receipt number"><input maxLength={180} value={value.invoiceNumber} onChange={event => change('invoiceNumber', event.target.value)} /></Field>
            <Field label="Total amount (if readable)" hint="No currency symbol or thousands separators; use a dot for decimals."><input required={value.destination === 'sales'} inputMode="decimal" value={value.amount} onChange={event => change('amount', event.target.value)} /></Field>
            <Field label="Currency"><input required maxLength={3} minLength={3} value={value.currency} onChange={event => change('currency', event.target.value.toUpperCase())} placeholder="For example, EUR" /></Field>
            <Field label="Category"><select required value={value.category} onChange={event => change('category', event.target.value)}>{value.destination === 'sales' ? <><option value="">Choose what was sold</option><option value="produce">Crops or farm produce</option><option value="livestock">Livestock</option><option value="services">Services</option><option value="other">Other sale</option></> : <><option value="">Choose what was bought</option><option value="inputs">Farm inputs</option><option value="equipment">Equipment</option><option value="services">Services</option><option value="energy">Energy or fuel</option><option value="other">Other expense</option></>}</select></Field>
            <Field label="Printed tax amount (if supplied)"><input inputMode="decimal" value={value.taxAmount} onChange={event => change('taxAmount', event.target.value)} /></Field>
            <Field label="Printed tax rate (if supplied)" hint="Keep the printed rate. No tax is calculated here."><input inputMode="decimal" value={value.taxRate} onChange={event => change('taxRate', event.target.value)} /></Field>
            <label className="check-row"><input type="checkbox" checked={value.credit} onChange={event => change('credit', event.target.checked)} />This is a credit or refund</label>
          </>}
          {value.destination === 'operations' && <>
            <Field label="What work actually happened?"><select required value={value.operationType} onChange={event => change('operationType', event.target.value)}><option value="">Choose the work</option><option value="fertiliser_application">Applied fertiliser</option><option value="pesticide_application">Applied crop protection</option><option value="input_application">Applied another farm input</option><option value="harvest">Harvested</option><option value="irrigation">Irrigated</option><option value="work">Other farm work</option><option value="observation">Recorded an observation</option><option value="animal_birth">Animals born</option><option value="animal_death">Animal deaths</option><option value="animal_purchase">Animals arrived after purchase</option><option value="animal_sale">Animals left after sale</option><option value="animal_movement">Animals moved</option><option value="animal_treatment">Animals treated</option>{value.operationType && !['fertiliser_application', 'pesticide_application', 'input_application', 'harvest', 'irrigation', 'work', 'observation', 'animal_birth', 'animal_death', 'animal_purchase', 'animal_sale', 'animal_movement', 'animal_treatment'].includes(value.operationType) && <option value={value.operationType}>Printed work: {value.operationType} (check this)</option>}</select></Field>
            <Field label="Product (if applicable)"><input maxLength={300} value={value.product} onChange={event => change('product', event.target.value)} /></Field>
            <Field label="Field, compartment or animal group"><input maxLength={300} value={value.parcel} onChange={event => change('parcel', event.target.value)} /></Field>
            <Field label="Work hours (if recorded)"><input inputMode="decimal" value={value.hours} onChange={event => change('hours', event.target.value)} /></Field>
          </>}
        </>}
        <Field label={value.destination === 'tasks' ? 'What should the person doing this know?' : 'Anything uncertain or worth explaining?'}><textarea rows={3} maxLength={4000} value={value.notes} onChange={event => change('notes', event.target.value)} /></Field>
        {issues.length > 0 && <div><h3>Check these details</h3>{issues.map((issue, index) => <Notice key={index} kind={issue.severity === 'warning' ? 'warning' : 'error'}>{words(issue.message, 'This detail needs review.')}{issue.severity === 'warning' && <label className="check-row"><input type="checkbox" checked={acknowledged.includes(words(issue.code))} onChange={event => setAcknowledged(previous => event.target.checked ? [...previous, words(issue.code)] : previous.filter(code => code !== issue.code))} />I read this warning and want to keep the entry for review.</label>}</Notice>)}</div>}
        <p>Read back: {value.recordTitle || `Name this ${recordName}`} for {selectedFarm ? words(selectedFarm.data.name) : 'a farm you still need to choose'}.{value.destination !== 'tasks' && value.destination !== 'facts' && <> Quantity: {value.quantity || 'unknown'} {value.unit || '(unit unknown)'}. {(value.destination === 'purchases' || value.destination === 'sales') && <>Total: {value.amount || 'unknown'} {value.currency || '(currency unknown)'}. {value.destination === 'sales' ? `Buyer: ${value.buyer || 'not yet identified'}. ` : ''}</>}Date: {value.date || 'unknown'}.</>}</p>
        <Button type="submit" disabled={!value.farmId}>{busy === 'save' ? 'Saving…' : value.destination === 'tasks' ? 'Save this task' : `Save ${recordName} for review`}</Button>
      </fieldset></form>
    </section>}
    {savedRecord && <section className="paper-section" aria-labelledby="saved-record"><h2 id="saved-record">Saved {kindLabel(savedRecord.kind)}</h2>
      <dl>{['title', 'label', 'date', 'due_date', 'quantity', 'unit', 'amount', 'currency', 'tax_amount', 'tax_rate', 'credit', 'invoice_number', 'supplier', 'buyer', 'type', 'product', 'parcel', 'value', 'period', 'temporal_basis'].filter(key => key in savedRecord.data).map(key => <div key={key}><dt>{({ temporal_basis: 'Applies to', tax_amount: 'Printed tax', due_date: 'Due date' } as Record<string, string>)[key] || key.replaceAll('_', ' ')}</dt><dd>{readable(savedRecord.data[key])}</dd></div>)}</dl>
      {savedRecord.kind !== 'tasks' && savedRecord.data.review_status === 'proposed' && <><p>Compare these saved values with the original. Confirmation records your review.</p>{Array.isArray(object(savedRecord.data.document_review).issues) && (object(savedRecord.data.document_review).issues as unknown[]).map((issue, index) => <Notice key={index} kind="warning">{words(object(issue).message)}</Notice>)}<Field label="What did you check? Explain any warning before confirming."><textarea rows={2} value={value.reviewExplanation} onChange={event => change('reviewExplanation', event.target.value)} maxLength={4000} /></Field>{canReview ? <Button disabled={!!busy || (Array.isArray(object(savedRecord.data.document_review).acknowledged_issue_codes) && (object(savedRecord.data.document_review).acknowledged_issue_codes as unknown[]).length > 0 && !value.reviewExplanation.trim())} onClick={() => void confirmSaved()}>Confirm this {kindLabel(savedRecord.kind)}</Button> : <Notice>A person with review permission can confirm this {kindLabel(savedRecord.kind)}. Your saved entry remains proposed.</Notice>}</>}
      {savedRecord.data.review_status === 'confirmed' && <Notice kind="success">Confirmed. The original remains attached.</Notice>}
      {savedRecord.kind === 'tasks' && <><p>Status: {savedRecord.data.status === 'done' ? 'Done' : 'Open'}</p><Button disabled={!!busy || !canWrite} onClick={() => void changeTaskStatus()}>{savedRecord.data.status === 'done' ? 'Reopen this task' : 'Mark this task done'}</Button>{canWrite && <TaskEdit key={savedRecord.id} record={savedRecord} onSaved={setSavedRecord} />}</>}
      <div className="actions"><Link to={savedRecord.kind === 'facts' ? `/app/fields/${words(savedRecord.data.farm_id)}#facts` : savedRecord.kind === 'tasks' ? `/app/fields/${words(savedRecord.data.farm_id)}` : `/app/record-work?farm_id=${words(savedRecord.data.farm_id)}&review=1`}>{['purchases', 'sales', 'operations'].includes(savedRecord.kind) ? 'Open notebook to change this entry' : 'Open saved farm records'}</Link><Button variant="secondary" onClick={() => { setSavedRecord(null); retryKeys.current.record = crypto.randomUUID(); draft.setValue(previous => ({ ...defaults, ...previous, recordTitle: '', amount: '', quantity: '', selectedProposals: [], reviewExplanation: '' })); }}>Save another record from this document</Button></div>
    </section>}
    {Array.isArray(document.data.saved_records) && document.data.saved_records.length > 0 && !savedRecord && <section className="paper-section"><h2>Already saved from this document</h2><ul>{document.data.saved_records.map((entry: unknown, index: number) => { const linked = object(entry); return <li key={index}><Button variant="ghost" disabled={!!busy} onClick={async () => { setBusy('open'); try { setSavedRecord(await api.get<RecordItem>(`/${words(linked.kind)}/${words(linked.id)}`)); } catch (cause) { setError(message(cause)); } finally { setBusy(''); } }}>Open saved {kindLabel(words(linked.kind))}</Button></li>; })}</ul></section>}
    {Array.isArray(document.data.request_ids) && document.data.request_ids.length > 0 && <section className="paper-section"><h2>Requests using this document</h2><ul>{document.data.request_ids.map((identifier: string) => <li key={identifier}><Link to={`/app/paperwork/${identifier}`}>Open request</Link></li>)}</ul></section>}
  </>;
}
