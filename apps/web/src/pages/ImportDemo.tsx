import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice } from '../components';
import { usePrivateDraft } from '../offline';
import type { Page, RecordItem } from '../types';
import './importDemo.css';

type Data = Record<string, unknown>;
type SourceKind = 'document' | 'csv';
type Bookmark = { kind: SourceKind; id: string | null };
type SourceRecord = RecordItem & { rows?: Page<RecordItem> };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const recordKinds = new Set(['facts', 'purchases', 'sales', 'operations', 'tasks']);
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const display = (value: unknown): string => value === null || value === undefined ? 'Not supplied' : value === '' ? 'Blank' : typeof value === 'object' ? Array.isArray(value) ? value.map(display).join(' · ') : Object.entries(value).map(([key, item]) => `${key.replaceAll('_', ' ')}: ${display(item)}`).join(' · ') : String(value);
const list = (value: unknown): Data[] => Array.isArray(value) ? value.map(object) : [];
const fileKind = (file: File): SourceKind => /\.csv$/i.test(file.name) || ['text/csv', 'application/csv', 'application/vnd.ms-excel'].includes(file.type) && !/\.xlsx?$/i.test(file.name) ? 'csv' : 'document';

function downloadSample(kind: SourceKind, farmId: string, farmName: string) {
  const receipt = [
    'DEMO RECEIPT', `Farm: ${farmName.replace(/[\r\n]/g, ' ').slice(0, 100)}`,
    `Demo farm record: ${farmId}`, 'Supplier: Sample Feed Cooperative', 'Date: 2026-06-15',
    'Invoice number: SAMPLE-0012', 'Item: Hay bales', 'Quantity: 12', 'Unit: bale',
    'Total: 144.00 EUR', 'Tax: not supplied', 'Payment status: not supplied',
  ].join('\n');
  const csv = 'Date,Description,Quantity,Unit,Total,Currency,Invoice\n2026-06-15,Hay purchase,12,bale,144.00,EUR,SAMPLE-0012\n2026-06-16,Seed purchase,,bag,24.50,EUR,SAMPLE-0013\n';
  const href = URL.createObjectURL(new Blob([kind === 'document' ? receipt : csv], { type: kind === 'document' ? 'text/plain;charset=utf-8' : 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = `sample-farm-${kind === 'document' ? 'receipt' : 'purchases'}-${farmId.slice(0, 8)}.${kind === 'document' ? 'txt' : 'csv'}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function checkedSource(value: SourceRecord, kind: SourceKind, workspaceId: string, farmId: string): SourceRecord {
  if (!value || !UUID.test(value.id) || value.kind !== (kind === 'document' ? 'documents' : 'imports') || value.workspace_id !== workspaceId || object(value.data).farm_id !== farmId) {
    throw new Error('This file could not be matched to the current farm and workspace. Open your documents or imports before trying again.');
  }
  return value;
}

export function ImportDemo({ farmId, farmName = 'Sample farm', showSamples = true }: { farmId: string; farmName?: string; showSamples?: boolean }) {
  const { session } = useSession();
  if (!session || !UUID.test(farmId)) return <Notice>Open a saved sample farm before importing a file.</Notice>;
  return <FarmImport key={`${session.user.id}/${session.workspace.id}/${farmId}`} farmId={farmId} farmName={farmName}
    workspaceId={session.workspace.id} showSamples={showSamples} canWrite={session.workspace.role === 'owner' || session.workspace.permissions?.includes('review') === true}/>;
}

function FarmImport({ farmId, farmName, workspaceId, canWrite, showSamples }: { farmId: string; farmName: string; workspaceId: string; canWrite: boolean; showSamples: boolean }) {
  const bookmark = usePrivateDraft<Bookmark>(`examples/import/${farmId}`, { kind: 'document', id: null });
  const [file, setFile] = useState<File | null>(null);
  const [delimiter, setDelimiter] = useState(',');
  const [showOriginal, setShowOriginal] = useState(false);
  const [source, setSource] = useState<SourceRecord | null>(null);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);
  const reads = useRef<AbortController | null>(null);
  const remembered = object(bookmark.value);
  const savedId = typeof remembered.id === 'string' || remembered.id === null ? remembered.id : 'invalid';
  const savedKind = remembered.kind;
  const validBookmark = (savedKind === 'document' || savedKind === 'csv') && (savedId === null || typeof savedId === 'string' && UUID.test(savedId));

  const reload = useCallback(async () => {
    if (!savedId || !UUID.test(savedId) || (savedKind !== 'document' && savedKind !== 'csv') || writing.current) return;
    const sequence = ++generation.current;
    reads.current?.abort();
    const controller = new AbortController(); reads.current = controller;
    setSource(null); setRecords([]); setSelectedSuggestion(0); setNotice(''); setError(''); setLoading(true);
    try {
      const response = await api.downloadResponse(savedKind === 'document' ? `/documents/${savedId}` : `/imports/${savedId}?limit=20`, { signal: controller.signal });
      const current = checkedSource(await response.json() as SourceRecord, savedKind, workspaceId, farmId);
      const references = savedKind === 'document' ? list(current.data.saved_records) : (current.rows?.items ?? []).map(row => object(row.data.promoted_record));
      const unique = [...new Map<string, Data>(references.filter(ref => recordKinds.has(text(ref.kind)) && UUID.test(text(ref.id))).map(ref => [`${ref.kind}/${ref.id}`, ref] as const)).values()].slice(0, 20);
      const results = await Promise.all(unique.map(async ref => {
        const result = await api.downloadResponse(`/${ref.kind}/${ref.id}`, { signal: controller.signal });
        const record = await result.json() as RecordItem;
        const linked = savedKind === 'document' ? record.data.document_id === savedId || object(record.data.document_review).document_id === savedId || list(record.data.sources).some(item => item.document_id === savedId) : list(record.data.sources).some(item => item.import_id === savedId);
        if (record.id !== ref.id || record.kind !== ref.kind || record.workspace_id !== workspaceId || record.data.farm_id !== farmId || !linked) throw new Error('A saved record could not be matched to this source.');
        return record;
      }));
      if (!mounted.current || sequence !== generation.current) return;
      setSource(current); setRecords(results); setError('');
    } catch (failure) {
      if (mounted.current && sequence === generation.current && !controller.signal.aborted) {
        generation.current += 1; controller.abort();
        setSource(null); setRecords([]); setSelectedSuggestion(0); setNotice('');
        setError(errorMessage(failure)); setLoading(false);
      }
    } finally { if (mounted.current && sequence === generation.current) setLoading(false); }
  }, [savedId, savedKind, validBookmark, workspaceId, farmId]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; reads.current?.abort(); };
  }, []);
  useEffect(() => { if (bookmark.ready && validBookmark) void reload(); }, [bookmark.ready, validBookmark, reload]);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || writing.current || !bookmark.ready || !canWrite) return;
    const chosenKind = fileKind(file);
    if (!/\.(csv|txt|pdf|png|jpe?g)$/i.test(file.name)) { setError('Choose a CSV, PDF, JPG, PNG or text file.'); return; }
    if (!file.size || file.size > (chosenKind === 'document' ? 12 : 20) * 1024 * 1024) {
      setError(`Choose a nonempty file no larger than ${chosenKind === 'document' ? 12 : 20} MiB.`); return;
    }
    writing.current = true; reads.current?.abort();
    const sequence = ++generation.current;
    setBusy(chosenKind === 'document' ? 'Saving the original…' : 'Opening the real CSV…'); setLoading(false); setError(''); setNotice('');
    let originalSaved = false;
    try {
      const form = new FormData(); form.append('file', file); form.append('farm_id', farmId);
      if (chosenKind === 'csv') { form.append('grain', 'One record as written in each source row'); form.append('delimiter', delimiter); }
      let saved = checkedSource(await api.upload<SourceRecord>(chosenKind === 'document' ? '/documents' : '/imports', form), chosenKind, workspaceId, farmId);
      originalSaved = true;
      if (!mounted.current || sequence !== generation.current) return;
      bookmark.setValue({ kind: chosenKind, id: saved.id }); setSource(saved); setRecords([]); setSelectedSuggestion(0);
      setFile(null); if (input.current) input.current.value = '';
      if (chosenKind === 'document') {
        setBusy('Reading the saved file…');
        saved = checkedSource(await api.post<SourceRecord>(`/documents/${saved.id}/extract`, { expected_revision: saved.revision, document_type: 'unknown' }), chosenKind, workspaceId, farmId);
      } else saved = checkedSource(await api.get<SourceRecord>(`/imports/${saved.id}?limit=20`), chosenKind, workspaceId, farmId);
      if (!mounted.current || sequence !== generation.current) return;
      setSource(saved);
      setNotice(chosenKind === 'document' ? list(object(saved.data.extraction).fields).length ? 'Ready to check. Compare the suggested details with your file.' : 'Your file is saved. Open the reader to add the details it could not read.' : 'Your rows are ready. Check the suggested column meanings before saving records.');
    } catch (failure) {
      if (!mounted.current || sequence !== generation.current) return;
      setError(originalSaved ? `The original is saved, but reading or previewing it did not finish. ${errorMessage(failure)} Open its review below to continue.` : errorMessage(failure));
      if (!originalSaved && failure instanceof ApiError && failure.status === 0) setNotice('The server may have kept the file before the connection stopped. Check Documents or Imports before uploading it again.');
    } finally { writing.current = false; if (mounted.current && sequence === generation.current) setBusy(''); }
  }

  const extraction = object(source?.data.extraction);
  const suggestions = list(extraction.fields);
  const highlighted = list(suggestions[selectedSuggestion]?.sources);
  const rows = source?.rows?.items ?? [];
  const reviewHref = source ? savedKind === 'document' ? `/app/documents/${source.id}?${new URLSearchParams({ farm_id: farmId })}` : `/app/imports?${new URLSearchParams({ import: source.id })}` : '';
  const sameSource = !!source && validBookmark && source.id === savedId;

  return <section className="import-demo" aria-label="Import a real file">
    <h3>1. Choose a file or photo</h3>
    <p>For {farmName}. We will read the file; you choose which details to keep.</p>
    {showSamples && <div className="actions"><span>Need a file to try?</span><Button variant="ghost" onClick={() => downloadSample('document', farmId, farmName)} disabled={!!busy}>Sample receipt</Button><Button variant="ghost" onClick={() => downloadSample('csv', farmId, farmName)} disabled={!!busy}>Sample CSV</Button></div>}
    <form onSubmit={upload} className="import-demo-upload">
      <Field label="File or photo" hint="CSV up to 20 MiB; PDF, JPG, PNG or text up to 12 MiB."><input ref={input} type="file" required disabled={!!busy || !canWrite} accept=".csv,.txt,.pdf,.png,.jpg,.jpeg,text/csv,text/plain,application/pdf,image/png,image/jpeg" onChange={event => { setFile(event.target.files?.[0] ?? null); setError(''); }}/></Field>
      {file && fileKind(file) === 'csv' && <Field label="CSV separator"><select value={delimiter} disabled={!!busy} onChange={event => setDelimiter(event.target.value)}><option value=",">Comma</option><option value=";">Semicolon</option><option value={'\t'}>Tab</option></select></Field>}
      <Button type="submit" loading={!!busy} disabled={!file || !bookmark.ready || !canWrite}>{busy || 'Read this file'}</Button>
    </form>
    {!canWrite && <Notice>You can read existing files. The farm owner must grant review permission before you can upload.</Notice>}
    {!bookmark.ready && <p role="status">Opening the saved import step…</p>}
    {bookmark.error && <Notice kind="warning">{bookmark.error}</Notice>}
    {!validBookmark && <Notice kind="error">The remembered source is invalid. Choose a file again; no existing records will be deleted.</Notice>}
    {error && <Notice kind="error">{error}{validBookmark && savedId && <div><Button variant="secondary" onClick={() => void reload()} disabled={!!busy || loading}>Reload saved source</Button></div>}</Notice>}{notice && <Notice>{notice}</Notice>}
    {source && sameSource && <div className="import-demo-result">
      <div className="section-heading"><h3>2. Check what we read</h3><Button variant="ghost" onClick={() => void reload()} disabled={!!busy || loading}>{loading ? 'Refreshing…' : 'Refresh saved records'}</Button></div>
      <p><strong>{text(source.data.filename, text(source.data.source_name, 'Saved source'))}</strong></p>
      {savedKind === 'document' ? <section aria-label="Read values from the original">
        <p>{suggestions.length ? `${suggestions.length} suggested details. Check them before saving.` : 'Open the reader to add or correct details.'}</p>
        {!!extraction.failure && <Notice kind="warning">{text(object(extraction.failure).message, 'Automatic reading was unavailable. The original is still saved.')}</Notice>}
        <div className={showOriginal ? 'import-demo-comparison' : ''}><div className="import-demo-suggestions" aria-label="Suggested fields">{suggestions.map((suggestion, index) => <Button key={text(suggestion.id, String(index))} variant={selectedSuggestion === index ? 'primary' : 'secondary'} aria-pressed={selectedSuggestion === index} onClick={() => { setSelectedSuggestion(index); setShowOriginal(true); }}><strong>{text(suggestion.label, text(suggestion.key, 'Suggested detail'))}</strong><span>{display(suggestion.value)}</span></Button>)}</div>
          {showOriginal && <div className="import-demo-original" aria-label="Extracted source lines">{list(extraction.pages).slice(0, 3).map((page, pageIndex) => <section key={pageIndex}><h4>Page {display(page.page)}</h4><ol>{list(page.lines).slice(0, 120).map((line, index) => {
            const selected = highlighted.some(item => item.page === page.page && Number(line.line) >= Number(item.line_start) && Number(line.line) <= Number(item.line_end ?? item.line_start));
            return <li key={index} value={Number(line.line)}>{selected ? <mark>{text(line.text)}</mark> : text(line.text) || ' '}</li>;
          })}</ol></section>)}{!list(extraction.pages).length && <p>No extracted text is available yet.</p>}<p className="muted">First three pages, up to 120 lines each. The reader shows the complete file.</p></div>}</div>
        {highlighted.filter(item => text(item.quote)).map((item, index) => <blockquote key={index}><p>{text(item.quote)}</p><cite>{item.source_kind === 'manual_transcription' ? 'Your transcription' : 'Read from the file'} · page {display(item.page)}, line {display(item.line_start)}</cite></blockquote>)}
      </section> : <section aria-label="Original CSV rows"><p>{display(source.data.row_count)} rows. Open the review to check column meanings, dates and any warnings.</p>
        <div className="import-demo-table"><table><thead><tr><th>Row</th>{list(source.data.columns).map((column, index) => <th key={index}>{text(column.header, `Column ${index + 1}`)}</th>)}</tr></thead><tbody>{rows.slice(0, 5).map(row => <tr key={row.id}><th>{display(row.data.row_number)}</th>{(Array.isArray(row.data.original_row) ? row.data.original_row : []).map((cell: unknown, index: number) => <td key={index}>{display(cell)}</td>)}</tr>)}</tbody></table></div><p className="muted">First {Math.min(rows.length, 5)} rows. The review includes every row and its checks.</p>
      </section>}
      <h3>3. Review and save your records</h3>
      <div className="actions"><Link className="button button-primary" to={reviewHref}>{savedKind === 'document' ? 'Review details and save' : 'Review rows and save'}</Link></div>
      <p className="muted">Saved records remain proposals until you confirm them.</p>
      {(!!records.length || loading) && <section className="import-demo-readback" aria-label="Saved records from this source"><h3>Saved records from this source</h3>
        {!records.length ? <p>{loading ? 'Reading the saved record links…' : 'No linked proposals have been read back yet.'}</p> : records.map(record => <article key={record.id}><h4>{text(record.data.title, text(record.data.label, 'Saved record'))}</h4><p className="badge">{record.data.review_status === 'confirmed' ? 'Confirmed' : record.data.review_status === 'proposed' ? 'Saved proposal — not confirmed' : 'Saved record'}</p><dl>{['date', 'quantity', 'unit', 'amount', 'currency', 'supplier', 'invoice_number', 'value'].filter(field => field in record.data).map(field => <div key={field}><dt>{field.replaceAll('_', ' ')}</dt><dd>{display(record.data[field])}</dd></div>)}</dl><Link to={reviewHref}>Open this source’s saved records and review controls</Link></article>)}
        {!!records.length && <p className="muted">Showing up to 20 saved records. Open the review for the complete file.</p>}
      </section>}
    </div>}
    {loading && !sameSource && <p role="status">Opening the remembered source…</p>}
    <p className="muted"><Link to="/app/documents">Your documents</Link> · <Link to="/app/imports">Your imports</Link></p>
  </section>;
}
