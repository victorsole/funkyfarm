import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { Page, Pack, RecordItem } from '../types';
import { CZECH_JOURNAL_PACK, HolderValue, RetainedCzechJournals } from './CzechJournal';
import { RetainedPortugueseJournals, PORTUGUESE_JOURNAL_PACK, portugueseJournalPath } from './RetainedPortugueseJournal';

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const show = (value: unknown): string => value === undefined || value === null ? 'Not recorded' : value === '' ? 'Blank entry' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : typeof value === 'string' ? value : JSON.stringify(value) ?? 'Not recorded';
export function ReportAnswer({ field }: { field: Data }) {
  if (field.journal_schema === 'pt-ppp-surface-v1') return <strong style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{field.value == null ? 'Not recorded' : field.value === '' ? 'Left blank' : show(field.value)}</strong>;
  if (field.key === 'cz.ppp.holder' || ['natural_person', 'legal_person'].includes(text(object(field.value).kind)) && object(field.value).identification_number) return <HolderValue value={field.value} />;
  const schema = object(field.row_schema);
  if (!Array.isArray(schema.row_columns) || field.missing === true) return <strong>{field.missing === true ? 'Not available - no matching record' : show(field.value)}</strong>;
  const value = object(field.value);
  const columns = schema.row_columns.map(object);
  const keys = [...columns.map(column => text(column.key)).filter(key => Object.hasOwn(value, key)), ...Object.keys(value).filter(key => !columns.some(column => column.key === key))];
  return <dl className="evidence-list">{keys.map(key => {
    const column = columns.find(item => item.key === key);
    return <div key={key}><dt>{column ? text(column.label, key) : 'Additional source column'} <small className="muted">({key})</small></dt><dd>{value[key] === '' ? 'Empty source cell' : show(value[key])}{column?.unit ? ` ${text(column.unit)}` : ''}</dd></div>;
  })}</dl>;
}
const failure = (error: unknown) => error instanceof Error ? error.message : 'The report could not be loaded or saved. Please try again.';
const reportName = (item: RecordItem) => {
  const pack = object(object(item.data.snapshot).pack);
  return text(item.data.title, `${text(pack.title, text(pack.name, text(item.data.pack_id, 'Farm report')))} · ${show(item.data.reporting_year)}`);
};
const statusName = (value: unknown) => {
  const status = text(value, 'Draft').replaceAll('_', ' ');
  return status.charAt(0).toUpperCase() + status.slice(1);
};
const periodLabel = (value: Data) => value.temporal_basis === 'static' ? 'Standing farm detail' : value.period === null || value.period === undefined || value.period === '' ? 'Period not recorded' : `${value.temporal_basis === 'campaign_year' ? 'Campaign year' : value.temporal_basis === 'calendar_date' ? 'Recorded on' : 'Period'} ${show(value.period)}`;
const capabilityLabel = (pack: Data) => pack.capability === 'reference_only' ? 'Reference dossier — national mapping unavailable' : pack.capability === 'generic_dossier' || !pack.country ? 'General farm evidence dossier' : 'Country format draft — review its mapping and limitations';
const relevantYear = (data: Data, year: string) => data.temporal_basis === 'static' || String(data.period ?? '') === year || text(data.date).slice(0, 4) === year || data.temporal_basis === 'calendar_date' && text(data.period).slice(0, 4) === year;
const hasSource = (source: unknown) => typeof source === 'string' ? source.trim().length > 0 : Object.keys(object(source)).length > 0;
type JournalCheck = { status: string; notice: string; checked_at: string; issues: { code: string; message: string; fix_url?: string }[] };
const checkJournalSelection = (requestId: string, operationIds: string[], documentIds: string[]) => api.get<JournalCheck>(`/requests/${encodeURIComponent(requestId)}/checks?${new URLSearchParams({ selected_operation_ids: operationIds.join(','), selected_document_ids: documentIds.join(',') })}`);

function JournalSelectionCheck({ requestId, operationIds, documentIds }: { requestId: string; operationIds: string[]; documentIds: string[] }) {
  const [result, setResult] = useState<JournalCheck | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [refresh, setRefresh] = useState(0);
  const operationsKey = operationIds.join(','); const documentsKey = documentIds.join(',');
  useEffect(() => {
    let active = true; setResult(null); setError(''); setLoading(true);
    checkJournalSelection(requestId, operationIds, documentIds).then(value => { if (active) setResult(value); }).catch(cause => { if (active) setError(failure(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [requestId, operationsKey, documentsKey, refresh]);
  return <section className="stack"><h3>Check these selected applications against the linked letter</h3>{loading && <p role="status">Checking the selected records and documents…</p>}{error && <Notice kind="error">The letter check is unavailable. No completion verdict is available. {error}</Notice>}{result && <><Notice kind={result.status === 'ready_for_review' ? 'success' : 'warning'}>{result.status === 'ready_for_review' ? 'Ready for your review.' : 'These details need attention.'} {result.notice}</Notice><ul>{result.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}{issue.fix_url?.startsWith('/app/') && <> <Link to={issue.fix_url}>Fix or review this detail</Link></>}</li>)}</ul><p className="muted">Checked {new Date(result.checked_at).toLocaleString()}. This check does not approve or file a journal.</p></>}<Button variant="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Check this selection again</Button></section>;
}

function SourceLink({ source, farmId, portuguese = false }: { source: unknown; farmId?: string; portuguese?: boolean }) {
  const item = object(source);
  const documentId = text(item.document_id);
  const factId = text(item.fact_id, text(item.id));
  const label = text(item.label, text(item.filename, documentId ? 'Original document' : factId ? 'Farm fact' : 'Source details'));
  const external = text(item.url);
  if (documentId) return <Link to={`/app/documents/${documentId}`}>{label}{item.page !== undefined ? ` · page ${show(item.page)}` : ''}</Link>;
  if (factId && farmId) return <Link to={portuguese ? portugueseJournalPath(farmId, { pt_journal_fact: factId, ...(item.revision !== undefined ? { pt_journal_fact_revision: String(item.revision) } : {}) }) : `/app/fields/${farmId}#fact-${factId}`}>{label}{item.revision !== undefined ? ` · revision ${show(item.revision)}` : ''}</Link>;
  if (/^https?:\/\//i.test(external)) return <a href={external} target="_blank" rel="noreferrer">{label}</a>;
  if (item.file_name) return <span>{text(item.file_name)}{item.row !== undefined || item.row_number !== undefined ? ` · row ${show(item.row ?? item.row_number)}` : ''}</span>;
  return <span>{typeof source === 'string' ? source : item.source_kind === 'manual_transcription' ? 'Reviewed manual transcription' : 'Source retained with this reviewed fact'}</span>;
}

function AmendmentChoices({ report, busy, onPrepare }: { report: RecordItem; busy: boolean; onPrepare: (selection: { selected_document_ids: string[]; operation_ids: string[] }) => void }) {
  const documents = useRecords('documents');
  const operations = useRecords('operations');
  const snapshot = object(report.data.snapshot);
  const priorDocuments = Array.isArray(snapshot.evidence) ? snapshot.evidence.map(object) : [];
  const priorOperations = Array.isArray(snapshot.operations) ? snapshot.operations.map(object) : [];
  const draft = usePrivateDraft(`report/${report.id}/amendment`, { documentIds: priorDocuments.map(item => text(item.id)), operationIds: priorOperations.map(item => text(item.id)) });
  const availableDocuments = documents.items.filter(item => !item.data.farm_id || item.data.farm_id === report.data.farm_id);
  const availableOperations = operations.items.filter(item => item.data.farm_id === report.data.farm_id && item.data.review_status === 'confirmed' && relevantYear(item.data, String(report.data.reporting_year)) && (report.data.pack_id !== CZECH_JOURNAL_PACK || item.data.type === 'pesticide_application' && object(item).active !== false));
  const toggle = (kind: 'documentIds' | 'operationIds', id: string, checked: boolean) => draft.setValue(previous => ({ ...previous, [kind]: checked ? [...previous[kind], id] : previous[kind].filter(value => value !== id) }));
  return <details><summary>Choose replacement documents or activities</summary><p>Current reviewed farm answers are carried forward. Choose which supporting records belong in the new version.</p>{draft.error && <Notice kind="error">{draft.error}</Notice>}{!draft.ready ? <p role="status">Opening your private amendment choices…</p> : <>
    <fieldset><legend>Documents in the amendment</legend>{availableDocuments.map(item => <label className="check-row" key={item.id}><input type="checkbox" disabled={busy} checked={draft.value.documentIds.includes(item.id)} onChange={event => toggle('documentIds', item.id, event.target.checked)} /><span>{text(item.data.filename, 'Supporting document')}</span></label>)}{priorDocuments.filter(item => !availableDocuments.some(available => available.id === item.id)).map(item => <label className="check-row" key={text(item.id)}><input type="checkbox" disabled={busy} checked={draft.value.documentIds.includes(text(item.id))} onChange={event => toggle('documentIds', text(item.id), event.target.checked)} /><span>{text(item.name, 'Earlier supporting document')} — not currently available; remove it to prepare a replacement.</span></label>)}</fieldset>
    <fieldset><legend>Activities in the amendment</legend>{availableOperations.map(item => <label className="check-row" key={item.id}><input type="checkbox" disabled={busy} checked={draft.value.operationIds.includes(item.id)} onChange={event => toggle('operationIds', item.id, event.target.checked)} /><span>{text(item.data.title, text(item.data.type, 'Farm activity').replaceAll('_', ' '))} · {text(item.data.date)}</span></label>)}{priorOperations.filter(item => !availableOperations.some(available => available.id === item.id)).map(item => <label className="check-row" key={text(item.id)}><input type="checkbox" disabled={busy} checked={draft.value.operationIds.includes(text(item.id))} onChange={event => toggle('operationIds', text(item.id), event.target.checked)} /><span>{text(object(item.data).title, 'Earlier farm activity')} — no longer available as a confirmed record.</span></label>)}</fieldset>
    {report.data.pack_id === CZECH_JOURNAL_PACK && report.data.request_id && <JournalSelectionCheck requestId={text(report.data.request_id)} operationIds={draft.value.operationIds} documentIds={draft.value.documentIds} />}
    {(documents.error || operations.error) && <Notice kind="error">Supporting records could not load. Refresh before changing the selection.</Notice>}<Button type="button" disabled={busy || documents.loading || operations.loading || !!documents.error || !!operations.error} onClick={() => onPrepare({ selected_document_ids: draft.value.documentIds, operation_ids: draft.value.operationIds })}>Prepare a new draft with this selection</Button><p className="muted" role="status">{draft.saving ? 'Saving your private amendment choices…' : 'Your choices are retained privately on this device.'}</p>
  </>}</details>;
}

export function ReportsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const farms = useRecords('farms');
  const facts = useRecords('facts');
  const documents = useRecords('documents');
  const requests = useRecords('requests');
  const operations = useRecords('operations');
  const [items, setItems] = useState<RecordItem[]>([]);
  const [packs, setPacks] = useState<Data[]>([]);
  const [initialAttempt] = useState(() => crypto.randomUUID());
  const draft = usePrivateDraft('reports/prepare', { farmId: '', year: String(new Date().getFullYear()), packId: '', requestId: '', factIds: [] as string[], documentIds: [] as string[], operationIds: [] as string[], attemptKey: initialAttempt });
  const importedSelection = useRef('');
  useEffect(() => {
    const signature = params.toString();
    if (!draft.ready || !params.get('farm_id') || params.get('pack_id') !== CZECH_JOURNAL_PACK || !params.has('operation_ids') || importedSelection.current === signature) return;
    draft.setValue(previous => ({ ...previous, farmId: params.get('farm_id')!, year: params.get('year') || previous.year, packId: CZECH_JOURNAL_PACK, requestId: '', factIds: [], documentIds: [], operationIds: (params.get('operation_ids') ?? '').split(',').filter(Boolean), attemptKey: crypto.randomUUID() }));
    importedSelection.current = signature;
  }, [draft.ready, params.toString()]);
  const { farmId, year, packId, factIds } = draft.value;
  const documentIds = draft.value.documentIds ?? [];
  const operationIds = draft.value.operationIds ?? [];
  const setFarmId = (value: string) => draft.setValue(previous => ({ ...previous, farmId: value, requestId: '', packId: '', factIds: [], documentIds: [], operationIds: [], attemptKey: crypto.randomUUID() }));
  const setYear = (value: string) => draft.setValue(previous => ({ ...previous, year: value, requestId: '', packId: '', factIds: [], operationIds: [], attemptKey: crypto.randomUUID() }));
  const setPackId = (value: string) => draft.setValue(previous => ({ ...previous, packId: value, attemptKey: crypto.randomUUID() }));
  const setFactIds = (value: (previous: string[]) => string[]) => draft.setValue(previous => ({ ...previous, factIds: value(previous.factIds), attemptKey: crypto.randomUUID() }));
  const toggleSelection = (kind: 'documentIds' | 'operationIds', id: string, selected: boolean) => draft.setValue(previous => ({ ...previous, [kind]: selected ? [...(previous[kind] ?? []), id] : (previous[kind] ?? []).filter(value => value !== id), attemptKey: crypto.randomUUID() }));
  const chooseRequest = (id: string) => {
    const request = requests.items.find(item => item.id === id);
    draft.setValue(previous => ({ ...previous, requestId: id, farmId: request ? text(request.data.farm_id) : previous.farmId, year: request ? String(request.data.reporting_year ?? previous.year) : previous.year, packId: request ? text(request.data.pack_id) : previous.packId, factIds: [], documentIds: [], operationIds: [], attemptKey: crypto.randomUUID() }));
  };
  const [loading, setLoading] = useState(true);
  const [packLoading, setPackLoading] = useState(false);
  const [error, setError] = useState('');
  const [packError, setPackError] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedFarm = farms.items.find(farm => farm.id === farmId);
  const country = text(selectedFarm?.data.country);
  const selectedPack = packs.find(pack => text(pack.id, text(pack.pack_id)) === packId);
  const farmFacts = facts.items.filter(fact => fact.data.farm_id === farmId && fact.data.review_status === 'confirmed' && relevantYear(fact.data, year));
  const farmDocuments = documents.items.filter(document => !document.data.farm_id || document.data.farm_id === farmId);
  const farmOperations = operations.items.filter(operation => operation.data.farm_id === farmId && operation.data.review_status === 'confirmed' && relevantYear(operation.data, year) && (packId !== CZECH_JOURNAL_PACK || operation.data.type === 'pesticide_application' && !operation.data.superseded_by && !operations.items.some(successor => successor.data.review_status === 'confirmed' && successor.data.supersedes_id === operation.id)));
  const invalidJournalSelection = packId === CZECH_JOURNAL_PACK ? operationIds.filter(id => !farmOperations.some(operation => operation.id === id && object(operation).active !== false)) : [];

  async function reload() {
    setLoading(true);
    try { setItems((await api.get<Page<RecordItem>>('/reports')).items); setError(''); }
    catch (cause) { setError(failure(cause)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    setPacks([]); setPackError('');
    if (!country || !/^\d{4}$/.test(year)) return;
    let active = true;
    setPackLoading(true);
    api.get<Page<Pack> | Pack[]>(`/packs?country=${encodeURIComponent(country)}&year=${encodeURIComponent(year)}`)
      .then(result => { if (active) setPacks((Array.isArray(result) ? result : result.items).map(pack => object(pack))); })
      .catch(cause => { if (active) setPackError(failure(cause)); })
      .finally(() => { if (active) setPackLoading(false); });
    return () => { active = false; };
  }, [country, year]);

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!farmId || !packId || busy || !draft.ready) return;
    if (packId === PORTUGUESE_JOURNAL_PACK) { navigate(portugueseJournalPath(farmId, draft.value.requestId ? { pt_journal_request: draft.value.requestId } : {})); return; }
    setBusy(true); setError('');
    try {
      if (packId === CZECH_JOURNAL_PACK && draft.value.requestId) await checkJournalSelection(draft.value.requestId, operationIds, documentIds);
      const result = await api.post<RecordItem>('/reports', { farm_id: farmId, request_id: draft.value.requestId || null, pack_id: packId, reporting_year: Number(year), fact_ids: factIds, selected_document_ids: documentIds, operation_ids: operationIds }, { idempotencyKey: draft.value.attemptKey || initialAttempt });
      await draft.clear();
      navigate(`/app/reports/${result.id}`);
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(false); }
  }

  return <>
    <PageHeader title="Reports" description="Prepare an answer from reviewed evidence. Keep every issued version." />
    {error && <Notice kind="error">{error}</Notice>}
    {draft.error && <Notice kind="error">{draft.error}</Notice>}
    <section className="paper-section" aria-labelledby="prepare-report">
      <h2 id="prepare-report">Prepare a report</h2>
      <p>Choose the farm, period and reporting pack, then select the confirmed facts to include.</p>
      {packId === CZECH_JOURNAL_PACK && <Notice>Prepare a manual Czech crop-protection journal from the exact application records you select. Select the separately checked holder fact below. Repeated applications remain separate rows; no total or authority filing is inferred. <Link to={`/app/record-work?farm_id=${farmId}#czech-journal`}>Complete or check applications and holder details</Link></Notice>}
      {packId === CZECH_JOURNAL_PACK && !draft.value.requestId && <p>No letter is linked. Check this journal before approving it.</p>}
      {packId === CZECH_JOURNAL_PACK && draft.value.requestId && <JournalSelectionCheck requestId={draft.value.requestId} operationIds={operationIds} documentIds={documentIds} />}
      {!!invalidJournalSelection.length && <Notice kind="warning">Some chosen application records are no longer active, checked or available for this year. They were not automatically replaced.<Button variant="secondary" onClick={() => draft.setValue(previous => ({ ...previous, operationIds: operationIds.filter(id => !invalidJournalSelection.includes(id)), attemptKey: crypto.randomUUID() }))}>Remove unavailable applications from the selection</Button></Notice>}
      {!draft.ready ? <p role="status">Opening your private report draft…</p> : <form onSubmit={prepare} className="form-grid">
        <Field label="Request to answer"><select value={draft.value.requestId ?? ''} onChange={event => chooseRequest(event.target.value)} disabled={busy || requests.loading}><option value="">General report — no linked request</option>{requests.items.map(request => <option key={request.id} value={request.id}>{text(request.data.title, 'Administrative request')}</option>)}</select></Field>
        <Field label="Farm"><select required value={farmId} onChange={event => setFarmId(event.target.value)} disabled={busy || farms.loading}><option value="">Choose a farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{text(farm.data.name, 'Unnamed farm')}</option>)}</select></Field>
        <Field label="Reporting year"><input required type="number" min="2000" max="2100" value={year} onChange={event => setYear(event.target.value)} disabled={busy} /></Field>
        <Field label="Reporting pack"><select required value={packId} onChange={event => setPackId(event.target.value)} disabled={busy || packLoading || !farmId}><option value="">{packLoading ? 'Loading available packs…' : 'Choose an available pack'}</option>{packs.map(pack => { const id = text(pack.id, text(pack.pack_id)); return <option key={id} value={id}>{text(pack.name, text(pack.title, id))}</option>; })}</select></Field>
        {selectedPack && <Notice><strong>{capabilityLabel(selectedPack)}</strong><p>{text(selectedPack.description, 'Review this format and its requirements before approval.')}{selectedPack.version ? ` Version ${show(selectedPack.version)}.` : ''}</p>{Array.isArray(selectedPack.limitations) && <ul>{selectedPack.limitations.map((item, index) => <li key={index}>{show(item)}</li>)}</ul>}</Notice>}
        {farmId && !country && <Notice>Add the farm’s country in <Link to={`/app/farm/${farmId}`}>My farm</Link> to find matching packs.</Notice>}
        {packError && <Notice kind="error">{packError}</Notice>}
        {farmId && country && !packLoading && !packs.length && !packError && <Notice>No pack is advertised for this farm and year. Change the period or check the farm details.</Notice>}
        {farmId && packId !== PORTUGUESE_JOURNAL_PACK && <fieldset className="fact-selection"><legend>Confirmed evidence to include</legend>
          {facts.loading ? <p role="status">Loading reviewed facts…</p> : farmFacts.length ? farmFacts.map(fact => <label className="check-row" key={fact.id}>
            <input type="checkbox" checked={factIds.includes(fact.id)} disabled={busy} onChange={event => setFactIds(previous => event.target.checked ? [...previous, fact.id] : previous.filter(id => id !== fact.id))} />
            <span>{text(fact.data.label, text(fact.data.key, 'Farm fact'))}: <strong>{fact.data.key === 'cz.ppp.holder' ? `${text(object(fact.data.value).name, 'Holder name not recorded')} · ${text(object(fact.data.value).address, 'Address not recorded')}` : show(fact.data.value)}</strong> {text(fact.data.unit)}<small className="muted">{periodLabel(fact.data)}</small></span>
          </label>) : <p>No confirmed facts are available. You can prepare a draft to see missing requirements, or <Link to={`/app/farm/${farmId}`}>review farm facts first</Link>.</p>}
        </fieldset>}
        {farmId && packId !== PORTUGUESE_JOURNAL_PACK && <fieldset className="fact-selection"><legend>Supporting documents to include</legend><p>Only the documents you select appear in this response. Other request attachments remain private.</p>{documents.loading ? <p role="status">Loading documents…</p> : farmDocuments.length ? farmDocuments.map(document => <label className="check-row" key={document.id}><input type="checkbox" checked={documentIds.includes(document.id)} disabled={busy} onChange={event => toggleSelection('documentIds', document.id, event.target.checked)} /><span>{text(document.data.filename, 'Supporting document')}</span></label>) : <p>No documents are available. <Link to="/app/documents">Add supporting evidence</Link>.</p>}{documents.error && <Notice kind="error">Documents could not load. Refresh before choosing evidence.</Notice>}</fieldset>}
        {farmId && packId !== PORTUGUESE_JOURNAL_PACK && <fieldset className="fact-selection"><legend>Farm activities to include</legend><p>Select reviewed activities for the report’s activity annex.</p>{operations.loading ? <p role="status">Loading farm activities…</p> : farmOperations.length ? farmOperations.map(operation => <label className="check-row" key={operation.id}><input type="checkbox" checked={operationIds.includes(operation.id)} disabled={busy} onChange={event => toggleSelection('operationIds', operation.id, event.target.checked)} /><span>{text(operation.data.title, text(operation.data.type, 'Farm activity').replaceAll('_', ' '))}<small className="muted">{text(operation.data.date)}{operation.data.quantity !== undefined ? ` · ${show(operation.data.quantity)} ${text(operation.data.unit)}` : ''}{operation.data.parcel ? ` · ${show(operation.data.parcel)}` : ''}</small></span></label>) : <p>No confirmed activities are available for this year. <Link to={`/app/fields/${farmId}`}>Review farm records</Link>.</p>}</fieldset>}
        {(farms.error || facts.error) && <Notice kind="error">Farm or fact records could not load. Refresh the page to retry.</Notice>}
        <div>{packId === PORTUGUESE_JOURNAL_PACK && <p>Choose and check the individual journal rows before preparing this report. Supporting documents are selected there too.</p>}<Button type="submit" disabled={busy || !farmId || !packId || facts.loading || !!facts.error || packId === CZECH_JOURNAL_PACK && (operations.loading || !!operations.error || !operationIds.length || !!invalidJournalSelection.length)}>{packId === PORTUGUESE_JOURNAL_PACK ? 'Choose Portuguese journal rows' : busy ? 'Preparing preview…' : 'Prepare preview'}</Button></div>
      </form>}
      {draft.ready && <p className="muted" role="status">{draft.error ? 'Your choices could not be saved on this device. Keep this page open while you resolve the error.' : draft.saving ? 'Saving your private draft on this device…' : 'Your report choices are retained privately on this device.'}</p>}
    </section>
    <section className="paper-section" aria-labelledby="saved-reports">
      <div className="section-heading"><h2 id="saved-reports">Reports and their history</h2><Button type="button" onClick={() => void reload()} disabled={loading}>Refresh</Button></div>
      {loading ? <p role="status">Loading reports…</p> : items.length ? <ul className="record-list">{items.map(item => <li key={item.id}><Link to={`/app/reports/${item.id}`}><strong>{reportName(item)}</strong><span className="muted">{statusName(item.data.status)} · revision {item.revision}</span>{object(item.data.amendment).needed === true && <strong>Records changed — review an amendment</strong>}</Link></li>)}</ul> : <p className="empty-state">Your prepared and issued reports will be kept here.</p>}
    </section>
  </>;
}

export function ReportDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [report, setReport] = useState<RecordItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [approved, setApproved] = useState(false);
  const receiptDraft = usePrivateDraft(`report/${id ?? 'unknown'}/receipt`, { reference: '', receiptDate: new Date().toISOString().slice(0, 10) });
  const { reference, receiptDate } = receiptDraft.value;
  const setReference = (value: string) => receiptDraft.setValue(previous => ({ ...previous, reference: value }));
  const setReceiptDate = (value: string) => receiptDraft.setValue(previous => ({ ...previous, receiptDate: value }));
  const [dependencies, setDependencies] = useState<Record<string, RecordItem[]>>({});
  const [dependencyError, setDependencyError] = useState('');
  const attemptKeys = useRef(new Map<string, string>());
  const mutationKey = (action: string, body: unknown) => {
    const signature = JSON.stringify([id, action, body]);
    const existing = attemptKeys.current.get(signature);
    if (existing) return existing;
    const key = crypto.randomUUID(); attemptKeys.current.set(signature, key); return key;
  };

  async function load() {
    if (!id) return;
    setLoading(true);
    try { setReport(await api.get<RecordItem>(`/reports/${id}`)); setError(''); setApproved(false); }
    catch (cause) { setError(failure(cause)); }
    finally { setLoading(false); }
  }
  useEffect(() => { setReport(null); setDependencies({}); setNotice(''); void load(); }, [id]);

  async function approve() {
    if (!report || report.data.can_approve !== true || !approved || busy) return;
    setBusy('approve'); setError('');
    try {
      const body = { expected_revision: report.revision, snapshot_checksum: text(report.data.checksum) };
      await api.post(`/reports/${report.id}/approve`, body, { idempotencyKey: mutationKey('approve', body) });
      await load(); setNotice('Approval recorded. This report keeps the reviewed snapshot.');
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(''); }
  }

  async function download(format: string) {
    if (!report || busy) return;
    setBusy(format); setError('');
    try {
      const blob = await api.download(`/reports/${report.id}/download?format=${encodeURIComponent(format)}`);
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = href; link.download = `farm-report-${report.id}.${format}`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(''); }
  }

  async function saveReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!report || busy || !receiptDraft.ready) return;
    setBusy('receipt'); setError('');
    try {
      const body = { expected_revision: report.revision, snapshot_checksum: text(report.data.checksum), reference, date: receiptDate };
      await api.post(`/reports/${report.id}/receipts`, body, { idempotencyKey: mutationKey('receipt', body) });
      await receiptDraft.clear();
      await load(); setNotice('Your manual delivery reference is recorded. It does not establish acceptance by an authority.');
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(''); }
  }

  async function findDependents(factId: string) {
    if (busy) return;
    setBusy(`dependencies-${factId}`); setDependencyError('');
    try {
      const result = await api.get<Page<RecordItem> | RecordItem[]>(`/facts/${factId}/reports`);
      setDependencies(previous => ({ ...previous, [factId]: Array.isArray(result) ? result : result.items }));
    } catch (cause) { setDependencyError(failure(cause)); }
    finally { setBusy(''); }
  }

  async function reissue(selection: { selected_document_ids?: string[]; operation_ids?: string[] } = {}) {
    if (!report || busy) return;
    if (report.data.pack_id === PORTUGUESE_JOURNAL_PACK) { navigate(portugueseJournalPath(text(report.data.farm_id), { pt_journal_reissue: report.id })); return; }
    setBusy('reissue'); setError('');
    try {
      const retained = object(report.data.snapshot);
      const journalSelection = report.data.pack_id === CZECH_JOURNAL_PACK ? { operation_ids: selection.operation_ids ?? (Array.isArray(retained.operations) ? retained.operations.map(value => text(object(value).id)).filter(Boolean) : []), selected_document_ids: selection.selected_document_ids ?? (Array.isArray(retained.evidence) ? retained.evidence.map(value => text(object(value).id)).filter(Boolean) : []) } : {};
      if (report.data.pack_id === CZECH_JOURNAL_PACK && report.data.request_id) await checkJournalSelection(text(report.data.request_id), journalSelection.operation_ids ?? [], journalSelection.selected_document_ids ?? []);
      const body = { expected_revision: report.revision, snapshot_checksum: text(report.data.checksum), ...selection, ...journalSelection };
      const result = await api.post<RecordItem>(`/reports/${report.id}/reissue`, body, { idempotencyKey: mutationKey('reissue', body) });
      navigate(`/app/reports/${result.id}`);
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(''); }
  }

  if (loading && !report) return <p role="status">Loading report…</p>;
  if (!report) return <><PageHeader title="Report unavailable" /><Notice kind="error">{error || 'This report could not be found.'}</Notice><Link to="/app/reports">Back to reports</Link></>;
  const data = report.data;
  const preview = object(data.snapshot);
  const pack = object(preview.pack);
  const amendment = object(data.amendment);
  const changes = Array.isArray(amendment.changes) ? amendment.changes.map(object) : [];
  const rawFields = preview.fields;
  const fields = Array.isArray(rawFields) ? rawFields.map(object) : Object.entries(object(rawFields)).map(([key, value]) => ({ key, value } as Data));
  const warnings = Array.isArray(preview.warnings) ? preview.warnings : [];
  const blockers = Array.isArray(data.current_blockers) ? data.current_blockers : Array.isArray(data.blockers) ? data.blockers : [];
  const missing = blockers.map(item => { const blocker = object(item); return text(blocker.message, typeof item === 'string' ? item : show(item)); });
  const formats = Array.isArray(data.supported_formats) ? data.supported_formats.filter((format): format is string => typeof format === 'string' && ['pdf', 'csv', 'json', 'xlsx'].includes(format)) : [];
  const sources = Array.isArray(preview.evidence) ? preview.evidence.map(value => { const evidence = object(value); return { document_id: evidence.id, label: evidence.name }; }) : [];
  const snapshots = Array.isArray(preview.facts) ? preview.facts.map(object) : [];
  const factIds = Array.from(new Set([...(Array.isArray(data.fact_ids) ? data.fact_ids.filter((value): value is string => typeof value === 'string') : []), ...snapshots.map(fact => text(fact.id, text(fact.fact_id))).filter(Boolean)]));
  const receipts = Array.isArray(data.receipts) ? data.receipts.map(value => { const receipt = object(value); return object(receipt.data ?? value); }) : [];
  const reissues = Array.isArray(data.reissues) ? data.reissues.map(object) : [];
  const activities = Array.isArray(preview.operations) ? preview.operations.map(object) : [];

  return <>
    <Link className="back-link" to="/app/reports">Back to reports</Link>
    <PageHeader title={reportName(report)} description={`${statusName(data.status)} · revision ${report.revision}`} action={<Button type="button" onClick={() => void load()} disabled={!!busy || loading}>Refresh status</Button>} />
    {error && <Notice kind="error">{error} Refresh if another person has changed this report.</Notice>}
    {notice && <div role="status"><Notice>{notice}</Notice></div>}
    {amendment.needed === true && <section className="paper-section" aria-labelledby="report-changed"><h2 id="report-changed">Review an amendment</h2><Notice>{text(amendment.message)}</Notice><ul className="record-list">{changes.map((change, index) => <li key={index}><strong>{text(change.label, 'Changed record')}</strong><p>{text(change.message)}</p>{change.previous && change.current ? <p>Issued answer: {show(object(change.previous).value)} {text(object(change.previous).unit)} → Current answer: {show(object(change.current).value)} {text(object(change.current).unit)}</p> : null}{change.previous_text ? <p>Issued activity: {text(change.previous_text)}<br />Current activity: {text(change.current_text)}</p> : null}</li>)}</ul><Button type="button" onClick={() => void reissue()} disabled={!!busy}>{busy === 'reissue' ? 'Preparing amendment…' : 'Prepare amendment for review'}</Button></section>}
    <section className="paper-section" aria-labelledby="report-review">
      <h2 id="report-review">Review your answer</h2>
      <p>{text(preview.capability_notice, 'Compare the values and their sources before approval. Report status is supplied by the server.')}</p>
      {data.pack_id === CZECH_JOURNAL_PACK && !data.request_id && <p>No letter is linked. Check this journal before approving it. A correction retains this original journal context.</p>}
      <p className="muted">{capabilityLabel(pack)}{pack.version ? ` · format version ${show(pack.version)}` : ''}{pack.country ? ` · ${show(pack.country)}` : ''}</p>
      {data.status !== 'issued' && missing.length > 0 && <Notice kind="error"><strong>Still needed</strong><ul>{missing.map((item, index) => <li key={index}>{typeof item === 'string' ? item : text(object(item).label, show(item))}</li>)}</ul></Notice>}
      {warnings.length > 0 && <Notice><strong>Before you use this report</strong><ul>{warnings.map((warning, index) => <li key={index}>{typeof warning === 'string' ? warning : text(object(warning).message, show(warning))}</li>)}</ul></Notice>}
      {fields.length ? <details open={data.pack_id !== PORTUGUESE_JOURNAL_PACK}><summary>Individual report fields and sources</summary><dl className="evidence-list">{fields.map((field, index) => <div key={index}><dt>{text(field.group_label) && <small className="muted">{text(field.group_label)} · </small>}{text(field.label, text(field.key, text(field.field, `Answer ${index + 1}`)))}</dt><dd><ReportAnswer field={field}/> {text(field.unit)}
        <p className="muted">{periodLabel(field)}</p>
        {field.fact_id ? <p><SourceLink source={{ fact_id: field.fact_id, revision: field.fact_revision, label: 'Reviewed farm fact' }} farmId={text(data.farm_id)} portuguese={field.journal_schema === 'pt-ppp-surface-v1'} /></p> : null}
        {Array.isArray(field.sources) && field.sources.some(hasSource) && <ul className="source-links">{field.sources.filter(hasSource).map((source, sourceIndex) => <li key={sourceIndex}><SourceLink source={source} farmId={text(data.farm_id)} /></li>)}</ul>}
      </dd></div>)}</dl></details> : <Notice>No field preview is available yet. Refresh the report after preparation completes.</Notice>}
      {activities.length > 0 && <div><h3>Selected farm activities</h3><ul className="record-list">{activities.map((activity, index) => { const value = object(activity.data); return <li key={text(activity.id, String(index))}><strong>{text(value.title, text(value.type, 'Farm activity').replaceAll('_', ' '))}</strong><p>{text(value.date)}{value.quantity !== undefined ? ` · ${show(value.quantity)} ${text(value.unit)}` : ''}{value.hours !== undefined ? ` · ${show(value.hours)} hours` : ''}{value.parcel ? ` · ${show(value.parcel)}` : ''}{value.crop ? ` · ${show(value.crop)}` : ''}</p></li>; })}</ul></div>}
      <RetainedCzechJournals journals={preview.journals} operations={preview.operations} />
      <RetainedPortugueseJournals key={text(data.checksum)} journals={preview.journals} farmId={text(data.farm_id)} />
      {sources.length > 0 && <details><summary>Source evidence</summary><ul className="source-links">{sources.map((source, index) => <li key={index}><SourceLink source={source} farmId={text(data.farm_id)} /></li>)}</ul></details>}
      {data.can_approve === true ? <div className="approval-section"><label className="check-row"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} disabled={!!busy} />I reviewed this report and its sources and approve this version.</label><Button type="button" onClick={() => void approve()} disabled={!approved || !!busy}>{busy === 'approve' ? 'Recording approval…' : 'Approve this version'}</Button></div> : <Notice>{text(data.approval_blocked_reason, data.status === 'issued' ? 'Approval is recorded for this issued snapshot.' : 'This report is not currently available for approval. Resolve the server’s requirements and refresh.')}</Notice>}
      {data.approval ? <details><summary>Recorded approval</summary><p>Approved {text(object(data.approval).at)} · {text(object(data.approval).role)} review</p><p className="muted">Snapshot checksum: {text(object(data.approval).snapshot_checksum)}</p></details> : null}
    </section>
    <section className="paper-section" aria-labelledby="report-download">
      <h2 id="report-download">Take your report with you</h2>
      <p>PDF is formatted for reading. CSV, JSON and XLSX retain exact values, units, periods and source revisions for reuse. A download does not submit the report to an authority.</p>
      {formats.length ? <div className="actions">{formats.map(format => <Button type="button" key={format} onClick={() => void download(format)} disabled={!!busy}>{busy === format ? 'Preparing file…' : `Download ${format.toUpperCase()}`}</Button>)}</div> : <p className="muted">Review and approve this draft to make its exports available.</p>}
      {data.status === 'issued' && <p><Link to={`/app/connections?farm_id=${encodeURIComponent(text(data.farm_id))}&report_id=${encodeURIComponent(report.id)}`}>View portal and file handoff options</Link></p>}
    </section>
    <section className="paper-section" aria-labelledby="report-receipts">
      <h2 id="report-receipts">Record a delivery reference</h2>
      <p>Use this after you deliver the report yourself. This is a manual record, not authority acceptance or automatic filing.</p>
      {receiptDraft.error && <Notice kind="error">{receiptDraft.error}</Notice>}
      {!receiptDraft.ready ? <p role="status">Opening your private reference draft…</p> : <form onSubmit={saveReceipt} className="form-grid"><Field label="Reference"><input required value={reference} onChange={event => setReference(event.target.value)} disabled={!!busy} /></Field><Field label="Delivery date"><input type="date" required value={receiptDate} onChange={event => setReceiptDate(event.target.value)} disabled={!!busy} /></Field><div><Button type="submit" disabled={!!busy || !reference.trim() || data.status !== 'issued'}>{busy === 'receipt' ? 'Saving reference…' : 'Save manual reference'}</Button></div></form>}
      <p className="muted" role="status">{receiptDraft.error ? 'Your reference could not be saved on this device. Keep this page open while you resolve the error.' : receiptDraft.saving ? 'Saving your private reference draft…' : data.status !== 'issued' ? 'Approve and issue the report before recording a delivery reference.' : 'Unsaved delivery details are retained privately on this device.'}</p>
      {receipts.length > 0 && <ul className="record-list">{receipts.map((receipt, index) => <li key={index}>{text(receipt.reference)} <span className="muted">{text(receipt.date)} · manually recorded</span></li>)}</ul>}
    </section>
    <section className="paper-section" aria-labelledby="report-corrections">
      <h2 id="report-corrections">Corrections and related reports</h2>
      <p>An issued snapshot stays intact. Correct the farm evidence first, check other reports using it, then prepare and review a new draft.</p>
      {data.status === 'issued' && <p><Link className="button button-secondary" to={`/app/cases/new?${new URLSearchParams({ farm_id: text(data.farm_id), job_type: 'correction', reporting_year: text(data.reporting_year), reference_kind: 'reports', reference_id: report.id, reference_revision: String(report.revision), reference_role: 'original' })}`}>Work through a correction</Link></p>}
      {text(data.farm_id) && <p><Link to={data.pack_id === PORTUGUESE_JOURNAL_PACK ? portugueseJournalPath(text(data.farm_id)) : `/app/fields/${text(data.farm_id)}`}>Review or correct the farm evidence</Link></p>}
      {dependencyError && <Notice kind="error">{dependencyError}</Notice>}
      {data.correction_of ? <p>This corrects <Link to={`/app/reports/${text(data.correction_of)}`}>an earlier report</Link>.</p> : null}
      {reissues.length > 0 && <ul>{reissues.map(reissue => <li key={text(reissue.id)}><Link to={`/app/reports/${text(reissue.id)}`}>Open correction draft or issued version</Link></li>)}</ul>}
      {factIds.length > 0 ? <ul className="record-list">{factIds.map(factId => <li key={factId}><div><SourceLink source={{ fact_id: factId, label: text(object(snapshots.find(fact => fact.id === factId || fact.fact_id === factId)?.data).label, 'Included fact') }} farmId={text(data.farm_id)} /> <Button type="button" disabled={!!busy} onClick={() => void findDependents(factId)}>{busy === `dependencies-${factId}` ? 'Checking…' : 'Show affected reports'}</Button></div>{dependencies[factId] && <ul>{dependencies[factId].map(dependent => <li key={dependent.id}><Link to={`/app/reports/${dependent.id}`}>{reportName(dependent)}</Link> · {statusName(dependent.data.status)}</li>)}{!dependencies[factId].length && <li>No dependent reports were returned.</li>}</ul>}</li>)}</ul> : <p className="muted">No fact dependencies were supplied for this report.</p>}
      {data.pack_id === PORTUGUESE_JOURNAL_PACK ? data.status === 'issued' ? <Link className="button button-secondary" to={portugueseJournalPath(text(data.farm_id), { pt_journal_reissue: report.id })}>Choose checked rows for a correction</Link> : <p><Link to={portugueseJournalPath(text(data.farm_id), data.correction_of ? { pt_journal_reissue: text(data.correction_of) } : data.request_id ? { pt_journal_request: text(data.request_id) } : {})}>Choose checked rows for a new preview</Link></p> : <><Button type="button" disabled={!!busy} onClick={() => void reissue()}>{busy === 'reissue' ? 'Preparing updated draft…' : data.status === 'issued' ? 'Prepare an amendment from current records' : 'Refresh into a new draft from current records'}</Button><AmendmentChoices key={report.id} report={report} busy={!!busy} onPrepare={selection => void reissue(selection)} /></>}
    </section>
  </>;
}
