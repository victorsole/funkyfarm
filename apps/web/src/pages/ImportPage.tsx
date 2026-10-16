import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { Page, RecordItem } from '../types';
import { DraftForm, useReviewAccess } from './Core';

type Target = 'facts' | 'operations' | 'purchases' | 'sales';
type Column = { source_index: number; header: string; target_field: string | null; role: 'value' | 'identifier' | 'foreign_key'; reference_kind?: string | null; value_type?: string; decimal_separator?: string; date_format?: string; blank_behavior?: string; null_tokens?: string[] };
type ImportRecord = RecordItem & { rows: Page<RecordItem> };
type Issue = { code: string; severity: 'error' | 'warning'; message: string; field?: string };
type Preview = { row: RecordItem; target: Target; data: Record<string, any>; normalized_data: Record<string, any>; issues: Issue[]; can_save: boolean; requires_acknowledgement: string[]; preview_token: string };
type PreviewPage = Page<Preview> & { import_revision: number };
type SavedRow = { row_number: number; status: 'saved' | 'failed'; record?: RecordItem; row?: RecordItem; error?: { code: string; message: string } };
type BatchResult = { items: SavedRow[]; saved_count: number; failed_count: number };
type MappingDraft = { target: Target; columns: Column[]; farm_id: string; temporal_basis: string; period: string; unit_mode: string; unit: string; key: string; label: string; title: string; currency: string };

const targetNames: Record<Target, string> = { facts: 'Farm facts or an earlier application', operations: 'Work, applications or observations', purchases: 'Purchases and receipts', sales: 'Sales and sales invoices' };
const fields: Record<Target, string[]> = {
  facts: ['farm_id', 'parcel_id', 'key', 'label', 'value', 'unit', 'period', 'temporal_basis', 'notes'],
  operations: ['farm_id', 'title', 'date', 'type', 'quantity', 'unit', 'period', 'temporal_basis', 'product', 'crop', 'parcel', 'parcel_id', 'operator', 'hours', 'external_id', 'notes'],
  purchases: ['farm_id', 'title', 'date', 'category', 'quantity', 'unit', 'amount', 'currency', 'period', 'temporal_basis', 'supplier', 'invoice_number', 'tax_amount', 'tax_rate', 'external_id', 'notes'],
  sales: ['farm_id', 'title', 'date', 'category', 'quantity', 'unit', 'amount', 'currency', 'period', 'temporal_basis', 'buyer', 'invoice_number', 'tax_amount', 'tax_rate', 'credit', 'external_id', 'notes'],
};
const labels: Record<string, string> = { farm_id: 'Farm record ID', key: 'Fact reference', label: 'What the fact describes', value: 'Value', title: 'Description', date: 'Actual date', type: 'Type of work', quantity: 'Quantity', unit: 'Unit', period: 'Year or date', temporal_basis: 'Time basis', amount: 'Amount', currency: 'Currency', category: 'Purchase category', product: 'Product', crop: 'Crop', parcel: 'Parcel name', parcel_id: 'Parcel, site or group reference', operator: 'Person', hours: 'Hours', external_id: 'Original record ID', supplier: 'Supplier', buyer: 'Buyer / customer', invoice_number: 'Invoice number', tax_amount: 'Tax amount', tax_rate: 'Tax rate', credit: 'Credit or refund (true / false)', notes: 'Notes' };
const fieldLabel = (field: string, target: Target) => field === 'category' && target === 'sales' ? 'Sale category' : labels[field] || field;
const numericFields = ['quantity', 'amount', 'tax_amount', 'tax_rate', 'hours'];
const display = (value: unknown) => value === null || value === undefined ? 'Not supplied' : value === '' ? 'Empty string' : typeof value === 'object' ? JSON.stringify(value) : String(value);

function Failure({ error }: { error: unknown }) {
  return error ? <Notice kind="error">{errorMessage(error)}{error instanceof ApiError && error.status === 409 && <p>Your entries are kept. Reload the preview, compare the saved version, and check the row before retrying.</p>}</Notice> : null;
}

function Issues({ items }: { items: Issue[] }) {
  return items.length ? <ul>{items.map((issue, index) => <li key={`${issue.code}-${index}`}><strong>{issue.severity === 'error' ? 'Needs correction' : 'Please check'}{issue.field ? ` · ${labels[issue.field] || issue.field}` : ''}:</strong> {issue.message}</li>)}</ul> : <p className="muted">No issues found by the available checks. The source still needs your review.</p>;
}

export function ImportsPage() {
  const { session } = useSession();
  return <ImportWorkspace key={session ? `${session.user.id}/${session.workspace.id}` : 'signed-out'} />;
}

function ImportWorkspace() {
  const imports = useRecords('imports');
  const farms = useRecords('farms');
  const canReview = useReviewAccess();
  const [params, setParams] = useSearchParams();
  const selected = params.get('import');
  const [detail, setDetail] = useState<ImportRecord | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  async function load(id: string) {
    const current = ++generation.current;
    setBusy(true); setError(null);
    try { const record = await api.get<ImportRecord>(`/imports/${encodeURIComponent(id)}?limit=20`); if (current === generation.current) setDetail(record); }
    catch (failure) { if (current === generation.current) setError(failure); }
    finally { if (current === generation.current) setBusy(false); }
  }
  useEffect(() => {
    setDetail(null);
    if (selected) void load(selected);
    return () => { generation.current += 1; };
  }, [selected]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) { setError(new Error('Choose a CSV file with source rows.')); return; }
    if (file.size > 20 * 1024 * 1024) { setError(new Error('Choose a CSV no larger than 20 MiB. Split larger files while keeping the original row references.')); return; }
    if (!form.get('farm_id')) form.delete('farm_id');
    setBusy(true); setError(null);
    try {
      const uploaded = await api.upload<RecordItem>('/imports', form);
      setParams({ import: uploaded.id });
      await imports.reload();
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }

  return <>
    <PageHeader title="Bring your records along" description="Reuse an earlier application or a CSV from your farm tools. Check the rows together, then save the ones you want to review." />
    <Failure error={error} />
    {imports.error && <Notice kind="error">{imports.error}<Button variant="secondary" onClick={() => void imports.reload()}>Reload imports</Button></Notice>}
    {farms.error && <Notice kind="error">{farms.error}<Button variant="secondary" onClick={() => void farms.reload()}>Reload farms</Button></Notice>}
    <section className="card"><h2>Add an existing record</h2><p>Use a comma-separated UTF-8 CSV, up to 20 MiB and 50,000 rows. For a photograph, PDF or letter, <Link to="/app/documents">add a document instead</Link>.</p>
      <DraftForm draftKey="import-upload" className="stack" onSubmit={upload} aria-busy={busy}>
        <div className="form-grid"><Field label="CSV file"><input name="file" type="file" accept=".csv,text/csv" required /></Field>
          <Field label="What does one source row describe?" hint="Keep the source meaning, such as one parcel per campaign, one application, or one fact per year."><input name="grain" required maxLength={200} placeholder="For example, one purchase" /></Field>
          <Field label="Farm (if the whole file belongs to one farm)"><select name="farm_id" defaultValue=""><option value="">Choose when reviewing</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field></div>
        <p className="muted">The file must be uploaded while connected. Form entries are kept privately on this device; after a restart, choose the file again.</p>
        <div><Button type="submit" loading={busy}>Open CSV for review</Button></div>
      </DraftForm>
    </section>
    <section className="card"><h2>Your imports</h2>{imports.loading && <Notice>Opening imports…</Notice>}{!imports.loading && !imports.items.length && <p className="muted">Your imported files will stay here, with their source rows and review history.</p>}
      <ul className="record-list">{imports.items.map(record => <li key={record.id}><Button variant="ghost" aria-pressed={selected === record.id} onClick={() => setParams({ import: record.id })}>{record.data.source_name} · {record.data.row_count} rows</Button></li>)}</ul>
    </section>
    {selected && busy && !detail && <Notice>Opening the saved source rows…</Notice>}
    {selected && error && <Button variant="secondary" onClick={() => void load(selected)}>Reload selected import</Button>}
    {detail && <ImportReview key={detail.id} imported={detail} farms={farms.items} canReview={canReview} onSaved={record => setDetail(current => current?.id === record.id ? { ...current, ...record } : current)} />}
  </>;
}

function initialMapping(imported: ImportRecord): MappingDraft {
  const defaults = imported.data.defaults || {};
  return { target: imported.data.target || 'facts', columns: imported.data.columns,
    farm_id: defaults.farm_id || imported.data.farm_id || '', temporal_basis: defaults.temporal_basis || '', period: defaults.period || '',
    unit_mode: Object.hasOwn(defaults, 'unit') ? defaults.unit === null ? 'unknown' : 'manual' : 'column', unit: defaults.unit || '',
    key: defaults.key || '', label: defaults.label || '', title: defaults.title || '', currency: defaults.currency || '' };
}

function mappingSignature(config: MappingDraft) {
  return JSON.stringify({ target: config.target, farm_id: config.farm_id, temporal_basis: config.temporal_basis, period: config.period,
    unit_mode: config.unit_mode, unit: config.unit_mode === 'manual' ? config.unit : '',
    key: config.target === 'facts' ? config.key : '', label: config.target === 'facts' ? config.label : '',
    title: config.target !== 'facts' ? config.title : '', currency: ['purchases', 'sales'].includes(config.target) ? config.currency : '',
    columns: config.columns.map(column => ({ source_index: column.source_index, target_field: column.target_field || null,
      role: column.role, reference_kind: column.reference_kind || null, value_type: column.value_type || 'text',
      decimal_separator: column.decimal_separator || '.', date_format: column.date_format || 'iso',
      blank_behavior: column.blank_behavior || 'preserve', null_tokens: column.null_tokens || [] })) });
}

function ImportReview({ imported, farms, canReview, onSaved }: { imported: ImportRecord; farms: RecordItem[]; canReview: boolean; onSaved: (record: RecordItem) => void }) {
  const draft = usePrivateDraft<MappingDraft>(`import-mapping:${imported.id}`, initialMapping(imported));
  const [preview, setPreview] = useState<PreviewPage | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const note = usePrivateDraft(`import-review-note:${imported.id}`, '');
  const [result, setResult] = useState<BatchResult | null>(null);
  const [manual, setManual] = useState<number | null>(null);
  const config = draft.value;
  const mappingDirty = mappingSignature(config) !== mappingSignature(initialMapping(imported));
  const requestNumber = useRef(0);
  const selectedRows = preview?.items.filter(item => selected.includes(item.row.data.row_number) && item.can_save) || [];
  const needsAcknowledgement = selectedRows.some(item => item.requires_acknowledgement.length > 0);
  const previewCurrent = preview?.import_revision === imported.revision;

  async function loadPreview(offset = 0) {
    const current = ++requestNumber.current;
    setBusy(true); setError(null); setAcknowledged(false);
    try { const page = await api.get<PreviewPage>(`/imports/${imported.id}/preview?limit=20&offset=${offset}`); if (current === requestNumber.current) { setPreview(page); setSelected([]); setManual(null); } }
    catch (failure) { if (current === requestNumber.current) setError(failure); }
    finally { if (current === requestNumber.current) setBusy(false); }
  }
  useEffect(() => { if (imported.data.target) void loadPreview(); return () => { requestNumber.current += 1; }; }, [imported.id]);

  function change(update: Partial<MappingDraft>) { draft.setValue(previous => ({ ...previous, ...update })); setPreview(null); setSelected([]); setResult(null); }
  function changeColumn(index: number, update: Partial<Column>) { change({ columns: config.columns.map(column => column.source_index === index ? { ...column, ...update } : column) }); }
  function matchNames() {
    const used = new Set<string>();
    const columns = config.columns.map(column => {
      const header = column.header;
      let field = header === 'value_json' && config.target === 'facts' ? 'value' : ['field_id', 'group_id'].includes(header) && !['purchases', 'sales'].includes(config.target) ? 'parcel_id' : fields[config.target].includes(header) ? header : null;
      if (field && used.has(field)) field = null;
      if (!field && (header.startsWith('source_') || ['holding_id', 'year', 'country', 'raw_value', 'value_origin', 'sqlite_type', 'lineage_path', 'lineage_sha256', 'temporal_warning', 'dataset_status', 'dataset_label', 'source_version'].includes(header))) field = `source.${header}`;
      if (field) used.add(field);
      return { ...column, target_field: field, value_type: field === 'credit' || header === 'value_json' && field === 'value' ? 'json' : field === 'date' ? 'date' : field && numericFields.includes(field) ? 'number' : 'text', blank_behavior: field === 'unit' || field === 'period' || field === 'date' ? 'null' : 'preserve' };
    });
    change({ columns });
  }

  async function saveMapping(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setResult(null);
    const defaults: Record<string, unknown> = {};
    if (config.farm_id) defaults.farm_id = config.farm_id;
    if (config.temporal_basis) defaults.temporal_basis = config.temporal_basis;
    if (config.period) defaults.period = config.period;
    else if (config.temporal_basis === 'static') defaults.period = null;
    if (config.unit_mode === 'unknown') defaults.unit = null;
    else if (config.unit_mode === 'manual' && config.unit) defaults.unit = config.unit;
    for (const field of config.target === 'facts' ? ['key', 'label'] : ['purchases', 'sales'].includes(config.target) ? ['title', 'currency'] : ['title']) {
      const value = config[field as keyof MappingDraft]; if (value) defaults[field] = value;
    }
    try {
      const record = await api.post<RecordItem>(`/imports/${imported.id}/mapping`, { expected_revision: imported.revision, target: config.target, columns: config.columns.map(({ header: _header, ...column }) => column), defaults });
      onSaved(record);
      draft.setValue(initialMapping({ ...imported, ...record }));
      await loadPreview();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  async function saveSelected(event: FormEvent) {
    event.preventDefault(); if (!preview || !selectedRows.length) return;
    setBusy(true); setError(null);
    try {
      const saved = await api.post<BatchResult>(`/imports/${imported.id}/rows/review`, {
        expected_revision: preview.import_revision, note: note.value,
        rows: selectedRows.map(item => ({ row_number: item.row.data.row_number, expected_revision: item.row.revision, preview_token: item.preview_token, acknowledged_issues: acknowledged ? item.requires_acknowledgement : [] })),
      });
      setResult(saved); await loadPreview(preview.offset);
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }

  return <section className="card"><h2>{imported.data.source_name}</h2><p>{imported.data.row_count} source rows · {imported.data.grain}</p>
    <p>Original cells stay unchanged, including blank strings, NULL text and zero. Column choices produce proposals for ordinary review.</p>
    <details><summary>Original file and traceability</summary><p>{imported.data.null_semantics}</p><p>SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{imported.data.sha256}</code></p><p>{imported.data.encoding} · comma-separated · {imported.data.source_bytes} bytes</p></details>
    <Failure error={error} />{draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {!canReview && <Notice>You can inspect the saved sources. Ask the farm owner for review permission to map columns or save proposals.</Notice>}
    {canReview && <form className="stack" onSubmit={saveMapping}>
      <fieldset disabled={!draft.ready || busy}><legend>Choose what to reuse</legend><div className="form-grid">
        <Field label="These rows contain"><select value={config.target} onChange={event => change({ target: event.target.value as Target, columns: config.columns.map(column => ({ ...column, target_field: null })), ...(event.target.value === 'sales' ? { temporal_basis: 'calendar_date', period: '' } : {}) })}>{Object.entries(targetNames).map(([target, label]) => <option key={target} value={target}>{label}</option>)}</select></Field>
        <Field label="Use this farm for all rows"><select value={config.farm_id} onChange={event => change({ farm_id: event.target.value })}><option value="">Use the mapped farm column</option>{farms.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field>
        <Field label="Time basis for all rows"><select value={config.temporal_basis} onChange={event => change({ temporal_basis: event.target.value })}><option value="">Use the mapped time-basis column</option>{config.target !== 'sales' && <><option value="static">Standing farm detail, not a new annual observation</option><option value="campaign_year">Campaign year / annual summary</option></>}<option value="calendar_date">An actual calendar date</option></select></Field>
        <Field label="Year or date for all rows" hint={config.target === 'sales' ? 'Leave blank to use each mapped actual sale date. An annual income total cannot supply a sale date.' : 'Leave blank if supplied by a column or if this is a standing detail.'}><input type={config.target === 'sales' ? 'date' : 'text'} value={config.period} onChange={event => change({ period: event.target.value })} placeholder="2026 or 2026-10-16" /></Field>
        <Field label="Unit for all rows"><select value={config.unit_mode} onChange={event => change({ unit_mode: event.target.value })}><option value="column">Use the mapped unit column</option><option value="unknown">Not supplied / unknown</option><option value="manual">I know the shared unit</option></select></Field>
        {config.unit_mode === 'manual' && <Field label="Shared unit"><input value={config.unit} required onChange={event => change({ unit: event.target.value })} placeholder="For example, ha or kg/ha" /></Field>}
        {config.target === 'facts' ? <><Field label="Shared fact reference (optional)"><input value={config.key} onChange={event => change({ key: event.target.value })} /></Field><Field label="Shared fact description (optional)"><input value={config.label} onChange={event => change({ label: event.target.value })} /></Field></> : <Field label="Shared description (optional)"><input value={config.title} onChange={event => change({ title: event.target.value })} /></Field>}
        {['purchases', 'sales'].includes(config.target) && <Field label="Shared currency (only if known)"><input value={config.currency} maxLength={3} placeholder="For example, EUR" onChange={event => change({ currency: event.target.value })} /></Field>}
      </div><p className="muted">Mapped row values take precedence over shared values. A receipt or purchase is not evidence of an actual input application.</p>
      {config.target === 'sales' && <Notice>Map the actual sale date, buyer, invoice reference, amount, currency and any printed tax or credit flag. Buyer information comes from its own source column; supplier names are not converted to buyers. Keep annual income summaries separate.</Notice>}
      <Button variant="secondary" onClick={matchNames}>Match column names for my review</Button>
      <div style={{ overflowX: 'auto' }}><table><caption>Column choices apply to every row. Only mapped columns become proposed fields.</caption><thead><tr><th scope="col">Original column and sample</th><th scope="col">Use as</th><th scope="col">Read the value as</th><th scope="col">More options</th></tr></thead><tbody>{config.columns.map(column => {
        const sample = imported.rows.items.find(row => row.data.original_row[column.source_index] !== '')?.data.original_row[column.source_index];
        return <tr key={column.source_index}><th scope="row">{column.header || `Column ${column.source_index + 1}`}<small className="muted" style={{ display: 'block', maxWidth: 220, overflowWrap: 'anywhere' }}>{sample === undefined ? 'No sample on this page' : display(sample)}</small></th>
          <td><select aria-label={`Destination for ${column.header || `column ${column.source_index + 1}`}`} value={column.target_field || ''} onChange={event => changeColumn(column.source_index, { target_field: event.target.value || null })}><option value="">Keep as source evidence only</option>{fields[config.target].map(field => <option key={field} value={field}>{fieldLabel(field, config.target)}</option>)}<option value={`source.${column.header || `column_${column.source_index + 1}`}`}>Source detail: {column.header || column.source_index + 1}</option></select></td>
          <td><select aria-label={`Value type for ${column.header}`} value={column.value_type || 'text'} onChange={event => changeColumn(column.source_index, { value_type: event.target.value })}><option value="text">Original text</option><option value="number">Number</option><option value="integer">Whole number</option><option value="date">Date</option><option value="json">Structured value (JSON)</option></select>
            {['number', 'integer'].includes(column.value_type || '') && <Field label="Source decimal mark"><select value={column.decimal_separator || '.'} onChange={event => changeColumn(column.source_index, { decimal_separator: event.target.value })}><option value=".">Dot: 12.5</option><option value=",">Comma: 12,5</option></select></Field>}
            {column.value_type === 'date' && <Field label="Source date format"><select value={column.date_format || 'iso'} onChange={event => changeColumn(column.source_index, { date_format: event.target.value })}><option value="iso">Year-month-day</option><option value="dmy">Day/month/year</option><option value="mdy">Month/day/year</option></select></Field>}</td>
          <td><details><summary>Blanks and source references</summary><Field label="Blank cells"><select value={column.blank_behavior || 'preserve'} onChange={event => changeColumn(column.source_index, { blank_behavior: event.target.value })}><option value="preserve">Preserve empty string</option><option value="null">Unknown / not supplied (null)</option><option value="missing">Use the shared value, if supplied</option></select></Field>
            <Field label="Literal text meaning unknown" hint="Exact match only. Leave blank to preserve every literal token."><input value={column.null_tokens?.[0] || ''} placeholder={'For example, \\N'} onChange={event => changeColumn(column.source_index, { null_tokens: event.target.value ? [event.target.value] : [] })} /></Field>
            <Field label="Reference check"><select value={column.role} onChange={event => changeColumn(column.source_index, { role: event.target.value as Column['role'], reference_kind: event.target.value === 'foreign_key' ? column.reference_kind || 'farms' : null })}><option value="value">No ID or join check</option><option value="identifier">Unique source reference</option><option value="foreign_key">Existing workspace record ID</option></select></Field>
            {column.role === 'foreign_key' && <Field label="Linked collection"><select value={column.reference_kind || 'farms'} onChange={event => changeColumn(column.source_index, { reference_kind: event.target.value })}>{['farms', 'facts', 'operations', 'purchases', 'sales'].map(kind => <option key={kind}>{kind}</option>)}</select></Field>}</details></td>
        </tr>;
      })}</tbody></table></div><div><Button type="submit" loading={busy}>Preview these column choices</Button></div></fieldset>
      {draft.saving && <p className="muted" role="status">Saving column choices privately on this device…</p>}
    </form>}
    {!preview && imported.data.target && !mappingDirty && <Button variant="secondary" loading={busy} onClick={() => void loadPreview()}>Open saved preview</Button>}
    {mappingDirty && <p className="muted">Your column choices differ from the saved mapping. Preview these choices before saving rows.</p>}
    {preview && <><h2>Check the rows together</h2><p>Rows {preview.offset + 1}–{preview.offset + preview.items.length} of {preview.total}. Select rows only after checking their values, dates and units.</p>
      {(!previewCurrent || mappingDirty) && <Notice kind="warning">The column choices changed. Preview the current choices before saving rows.</Notice>}
      {canReview && <div className="actions"><Button variant="secondary" disabled={busy} onClick={() => { setSelected(preview.items.filter(item => item.can_save).map(item => item.row.data.row_number)); setAcknowledged(false); }}>Select reviewable rows on this page</Button><Button variant="ghost" disabled={busy} onClick={() => setSelected([])}>Clear selection</Button></div>}
      {preview.items.map(item => <article className="panel" key={`${item.row.id}-${item.row.revision}`}>
        <div className="actions">{canReview && <label><input type="checkbox" disabled={!item.can_save || busy} checked={selected.includes(item.row.data.row_number)} onChange={event => { setSelected(previous => event.target.checked ? [...previous, item.row.data.row_number] : previous.filter(number => number !== item.row.data.row_number)); setAcknowledged(false); }} /> Select row {item.row.data.row_number}</label>}
          <strong>{display(item.normalized_data.label || item.normalized_data.title || `Row ${item.row.data.row_number}`)}</strong><span className="badge">{item.row.data.promoted_record ? 'Proposal saved' : item.can_save ? item.requires_acknowledgement.length ? 'Check warnings' : 'Ready for review' : 'Needs attention'}</span></div>
        <p>{item.target === 'facts' ? display(item.normalized_data.value) : `${display(item.normalized_data.quantity)} ${display(item.normalized_data.unit)}`} {item.target === 'facts' && item.normalized_data.unit ? item.normalized_data.unit : ''} · {display(item.normalized_data.period)} · {display(item.normalized_data.temporal_basis).replaceAll('_', ' ')}</p>
        <Issues items={item.issues} />
        <details><summary>Original cells and proposed fields</summary><dl>{imported.data.columns.map((column: Column) => <div key={column.source_index}><dt>{column.header || `Column ${column.source_index + 1}`}</dt><dd style={{ overflowWrap: 'anywhere' }}>{display(item.row.data.original_row[column.source_index])}</dd></div>)}</dl><h3>Proposed fields</h3><dl>{Object.entries(item.normalized_data).filter(([field]) => field !== 'sources').map(([field, value]) => <div key={field}><dt>{labels[field] || field}</dt><dd>{display(value)}</dd></div>)}</dl><p>{item.row.data.diagnostics?.identifiers_assessed ? 'Mapped source references checked.' : 'No source ID check selected.'} {item.row.data.diagnostics?.joins_assessed ? 'Mapped workspace links checked.' : 'No workspace join check selected.'}</p></details>
        {item.row.data.promoted_record ? <Link to={`/app/farm/${item.normalized_data.farm_id || imported.data.farm_id || ''}#${item.target}`}>Review the saved proposal in My farm</Link> : canReview && <><Button variant="secondary" disabled={busy} onClick={() => setManual(manual === item.row.data.row_number ? null : item.row.data.row_number)}>{manual === item.row.data.row_number ? 'Close row correction' : 'Correct this row'}</Button>{manual === item.row.data.row_number && <ManualRow item={item} imported={imported} farms={farms} onSaved={async () => { setResult(null); await loadPreview(preview.offset); }} />}</>}
      </article>)}
      {canReview && <form className="stack" onSubmit={saveSelected}><Field label="What did you check in the selected rows?"><textarea value={note.value} required maxLength={4000} onChange={event => note.setValue(event.target.value)} placeholder="For example, compared dates and quantities with the original farm log." /></Field>{note.error && <Notice kind="warning">{note.error}</Notice>}
        {needsAcknowledgement && <label><input type="checkbox" checked={acknowledged} required onChange={event => setAcknowledged(event.target.checked)} /> I checked the warnings on each selected row and want to keep these proposed records.</label>}
        <p className="muted">This saves proposals. Confirm facts and work records in My farm before using them as reviewed evidence.</p><div><Button type="submit" loading={busy} disabled={!previewCurrent || mappingDirty || !selectedRows.length || !note.ready || needsAcknowledgement && !acknowledged}>Save {selectedRows.length || ''} selected {selectedRows.length === 1 ? 'proposal' : 'proposals'}</Button></div>
      </form>}
      <div className="actions"><Button variant="secondary" disabled={busy || preview.offset === 0} onClick={() => void loadPreview(Math.max(0, preview.offset - 20))}>Previous rows</Button><Button variant="secondary" disabled={busy || preview.offset + preview.items.length >= preview.total} onClick={() => void loadPreview(preview.offset + 20)}>Next rows</Button><Button variant="ghost" disabled={busy} onClick={() => void loadPreview(preview.offset)}>Reload preview</Button></div>
    </>}
    {result && <Notice kind={result.failed_count ? 'warning' : 'success'}><p>{result.saved_count} {result.saved_count === 1 ? 'proposal saved' : 'proposals saved'}.{result.failed_count ? ` ${result.failed_count} rows still need attention; saved proposals were kept. Review the refreshed rows before retrying.` : ' The original source rows are retained.'}</p>{result.items.filter(item => item.status === 'failed').map(item => <p key={item.row_number}>Row {item.row_number}: {item.error?.message}</p>)}{result.items.filter(item => item.record).map(item => <p key={item.row_number}><Link to={`/app/farm/${item.record!.data.farm_id}#${item.record!.kind}`}>Review row {item.row_number} in My farm</Link></p>)}</Notice>}
  </section>;
}

function ManualRow({ item, imported, farms, onSaved }: { item: Preview; imported: ImportRecord; farms: RecordItem[]; onSaved: () => Promise<void> }) {
  const initial: Record<string, string> = {};
  for (const [field, value] of Object.entries(item.normalized_data)) if (field !== 'sources') initial[field] = value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  initial.value_type = item.normalized_data.value === null ? 'null' : typeof item.normalized_data.value === 'number' ? 'number' : typeof item.normalized_data.value === 'boolean' ? 'json' : typeof item.normalized_data.value === 'object' ? 'json' : 'text';
  if (initial.value_type === 'json') initial.value = JSON.stringify(item.normalized_data.value);
  initial.note = '';
  const draft = usePrivateDraft(`import-row:${item.row.id}`, initial);
  const [checked, setChecked] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  function update(field: string, value: string) { draft.setValue(previous => ({ ...previous, [field]: value })); setChecked(null); setAcknowledged(false); }
  async function check(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const data: Record<string, any> = { ...item.data };
      delete data.field_id; delete data.group_id;
      for (const field of fields[item.target]) {
        if (field === 'value') continue;
        const raw = draft.value[field] || '';
        if (field === 'credit') {
          if (raw !== 'true' && raw !== 'false') throw new Error('Choose explicitly whether this sale is a credit or refund.');
          data[field] = raw === 'true';
        } else if (numericFields.includes(field)) {
          if (raw && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw)))) throw new Error(`${labels[field]} needs a number with a decimal dot. Use the column choices to interpret a decimal-comma source.`);
          data[field] = raw === '' ? null : Number(raw);
        } else if (['unit', 'period', 'date', 'parcel_id'].includes(field)) data[field] = raw === '' ? null : raw;
        else data[field] = raw;
      }
      if (item.target === 'facts') {
        const raw = draft.value.value || '';
        if (draft.value.value_type === 'null') data.value = null;
        else if (draft.value.value_type === 'json') {
          data.value = JSON.parse(raw);
          const safe = (value: unknown): boolean => typeof value === 'number' ? Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER : Array.isArray(value) ? value.every(safe) : value !== null && typeof value === 'object' ? Object.values(value).every(safe) : true;
          if (!safe(data.value)) throw new Error('The structured value contains a number that would lose precision. Keep identifiers as text.');
        }
        else if (draft.value.value_type === 'number') {
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw)) || Math.abs(Number(raw)) > Number.MAX_SAFE_INTEGER) throw new Error('Enter a numeric value with a decimal dot, or explicitly choose unknown. Keep very large identifiers as text.');
          data.value = Number(raw);
        } else data.value = raw;
      }
      setChecked(await api.post<Preview>(`/imports/${imported.id}/rows/${item.row.data.row_number}/preview`, { expected_revision: item.row.revision, target: item.target, data }));
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  async function save() {
    if (!checked) return; setBusy(true); setError(null);
    try {
      await api.post(`/imports/${imported.id}/rows/${item.row.data.row_number}/review`, { expected_revision: item.row.revision, target: item.target, data: checked.data, note: draft.value.note, preview_token: checked.preview_token, acknowledged_issues: acknowledged ? checked.requires_acknowledgement : [] });
      await draft.clear(); await onSaved();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <form className="stack" onSubmit={check}><h3>Correct row {item.row.data.row_number}</h3><Failure error={error} />{draft.error && <Notice kind="warning">{draft.error}</Notice>}
    <fieldset disabled={!draft.ready || busy}><legend>Use only values supported by this source or your explicit correction</legend><div className="form-grid">{fields[item.target].map(field => <Field key={field} label={fieldLabel(field, item.target)}>
      {field === 'farm_id' ? <select value={draft.value[field] || ''} onChange={event => update(field, event.target.value)} required><option value="">Choose a farm</option>{farms.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select>
        : field === 'credit' ? <select value={draft.value[field] || ''} onChange={event => update(field, event.target.value)} required><option value="">Choose explicitly</option><option value="false">No</option><option value="true">Yes, credit or refund</option></select>
        : field === 'temporal_basis' ? <select value={draft.value[field] || ''} onChange={event => update(field, event.target.value)} required><option value="">Choose time basis</option>{item.target !== 'sales' && <><option value="static">Standing detail</option><option value="campaign_year">Campaign year / annual summary</option></>}<option value="calendar_date">Actual calendar date</option></select>
        : <input value={draft.value[field] || ''} type={field === 'date' || field === 'period' && item.target === 'sales' ? 'date' : 'text'} required={['key', 'label', 'title'].includes(field) || item.target === 'sales' && ['date', 'buyer', 'amount', 'currency', 'category'].includes(field)} onChange={event => update(field, event.target.value)} />}
    </Field>)}{item.target === 'facts' && <Field label="Kind of fact value"><select value={draft.value.value_type} onChange={event => update('value_type', event.target.value)}><option value="text">Text (blank stays an empty string)</option><option value="number">Number</option><option value="null">Unknown / not supplied (null)</option><option value="json">Structured value or yes/no (JSON)</option></select></Field>}</div>
    <p className="muted">A blank unit or period explicitly means not supplied. An annual summary needs its real campaign year; a missing event date is kept missing.</p>
    <Field label="What did you correct or check?"><textarea required value={draft.value.note || ''} maxLength={4000} onChange={event => update('note', event.target.value)} /></Field><Button type="submit" variant="secondary" loading={busy}>Check this correction</Button></fieldset>
    {checked && <><Issues items={checked.issues} /><details><summary>Checked proposed values</summary><dl>{Object.entries(checked.normalized_data).filter(([field]) => field !== 'sources').map(([field, value]) => <div key={field}><dt>{labels[field] || field}</dt><dd>{display(value)}</dd></div>)}</dl></details>{checked.requires_acknowledgement.length > 0 && <label><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /> I checked the warnings and want to keep this proposed record.</label>}<Button loading={busy} disabled={!checked.can_save || checked.requires_acknowledgement.length > 0 && !acknowledged} onClick={() => void save()}>Save corrected proposal</Button></>}
  </form>;
}
