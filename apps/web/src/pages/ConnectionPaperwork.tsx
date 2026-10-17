import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { Button, Field, Notice } from '../components';
import { useRecords } from '../hooks';
import type { Page, RecordItem } from '../types';

type Connection = RecordItem<{ farm_id: string; capability_id: string; status: string; title: string; credentials_present: boolean }>;
type ReportField = { label?: string; field?: string; value?: unknown; unit?: string; missing?: boolean; mapping?: string; sources?: { filename?: string; file_name?: string; page?: number; quote?: string }[] };
type Snapshot = { pack?: { title?: string; capability?: string; workflow_id?: string; country?: string | null }; fields?: ReportField[]; capability_notice?: string };
type Preview = RecordItem<{ checksum: string; expires_at: string; report_snapshot: Snapshot; binding: { report_id: string; report_checksum: string; official_url: string } }> & { review_state?: { available: boolean; reason: string | null } };
type Handoff = RecordItem<{ report_id: string; report_snapshot?: Snapshot; downloads: Record<string, string>; official_url: string; prepared_at: string }> & { current_state?: { available: boolean; reason: string | null } };
const dateText = (value: string) => new Date(value).toLocaleString();
const safeLink = (url: string) => { try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined; } catch { return undefined; } };
function valueText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return null;
}

function CopyFields({ snapshot, reportId, available }: { snapshot?: Snapshot; reportId: string; available: boolean }) {
  const [copied, setCopied] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const fields = snapshot?.fields || [];
  const mapped = !!snapshot?.pack?.country && ['sourced_draft_mapping', 'manual_preparation'].includes(snapshot.pack.capability || '');
  const formFields = mapped ? fields.filter(field => field.mapping !== 'supporting_fact' && !field.field?.startsWith('annex.') && !field.missing) : [];
  async function copy(field: ReportField, index: number) {
    const value = valueText(field.value); if (value === null || !available) return;
    setError(''); setCopied(null);
    try { await navigator.clipboard.writeText(value); setCopied(index); } catch { setError('Your browser could not copy it. You can select the value below and copy it yourself.'); }
  }
  return <section className="connection-copy-fields"><h3>Values to take with you</h3><p>These are the labels and values saved in the approved report. Check the current official form before using them. No website fields are filled in automatically.</p>
    {error && <Notice kind="error">{error}</Notice>}
    {formFields.length ? <><ol className="connection-value-list" start={page * 8 + 1}>{formFields.slice(page * 8, page * 8 + 8).map((field, offset) => { const index = page * 8 + offset; const value = valueText(field.value); return <li key={index}><div><strong>{field.label || 'Report value'}</strong><span className="connection-form-label">{field.field}</span><p className="connection-copy-value">{value ?? 'This value contains several rows. Open the report to review them.'}{field.unit && <span> {field.unit}</span>}</p><small>{field.sources?.length ? `${field.sources.length} saved source reference${field.sources.length === 1 ? '' : 's'}` : 'Check the report for source details'}{field.sources?.[0]?.page ? ` · page ${field.sources[0].page}` : ''}</small></div>{value !== null ? <Button variant="secondary" disabled={!available} onClick={() => void copy(field, index)}>{copied === index ? 'Copied' : 'Copy value'}</Button> : <Link to={`/app/reports/${reportId}`}>Open report rows</Link>}</li>; })}</ol>
      {formFields.length > 8 && <div className="actions"><Button variant="secondary" disabled={page === 0} onClick={() => { setPage(page - 1); setCopied(null); }}>Previous values</Button><span>Page {page + 1} of {Math.ceil(formFields.length / 8)}</span><Button variant="secondary" disabled={(page + 1) * 8 >= formFields.length} onClick={() => { setPage(page + 1); setCopied(null); }}>More values</Button></div>}</> : <p>This report is a records folder, not a mapped national form. Download it as supporting paperwork; there are no verified form fields to copy from this page.</p>}
    <p><Link to={`/app/reports/${reportId}`}>Open the complete report and its sources</Link></p>
  </section>;
}

export function ConnectionPaperwork({ farm, connection, ensureConnection, workflow, canManage, historyOnly = false }: { farm: RecordItem; connection?: Connection; ensureConnection: () => Promise<Connection>; workflow: string; canManage: boolean; historyOnly?: boolean }) {
  const [query, setQuery] = useSearchParams();
  const reports = useRecords(`reports?farm_id=${encodeURIComponent(farm.id)}`);
  const cases = useRecords(`cases?farm_id=${encodeURIComponent(farm.id)}`);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [reload, setReload] = useState(0);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const alive = useRef(true);
  const generation = useRef(0);
  const previewId = query.get('preview_id') || '';
  const handoffId = query.get('handoff_id') || '';
  const reportId = query.get('report_id') || '';
  const report = reports.items.find(item => item.id === reportId && item.data.status === 'issued' && item.data.farm_id === farm.id);
  const issued = reports.items.filter(item => item.data.status === 'issued' && (!item.data.snapshot?.pack?.workflow_id || item.data.snapshot.pack.workflow_id === workflow));
  const available = !!preview && preview.review_state?.available !== false && Date.parse(preview.data.expires_at) > Date.now();
  const handoffCurrent = handoff?.current_state?.available === true;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; }; }, []);
  useEffect(() => {
    let current = true; setError(''); setLoadError(''); setChecked(false); setPreview(null); setHandoff(null);
    if (!connection) return;
    setLoading(true);
    const load = async () => {
      try {
        if (handoffId) { const item = await api.get<Handoff>(`/connections/${connection.id}/handoffs/${encodeURIComponent(handoffId)}`); if (current) setHandoff(item); }
        else if (previewId) { const item = await api.get<Preview>(`/connections/${connection.id}/previews/${encodeURIComponent(previewId)}`); if (current) setPreview(item); }
      } catch (failure) { if (current) setLoadError(errorMessage(failure)); }
      finally { if (current) setLoading(false); }
    };
    void load(); return () => { current = false; };
  }, [connection?.id, previewId, handoffId, reload]);
  useEffect(() => {
    let current = true;
    if (!connection) { setPreviews([]); setHandoffs([]); setTotal(0); return; }
    Promise.all([api.get<Page<Preview>>(`/connections/${connection.id}/previews?limit=5&offset=${page * 5}`), api.get<Page<Handoff>>(`/connections/${connection.id}/handoffs?limit=5&offset=${page * 5}`)]).then(([savedPreviews, savedHandoffs]) => {
      if (current) { setPreviews(savedPreviews.items); setHandoffs(savedHandoffs.items); setTotal(Math.max(savedPreviews.total, savedHandoffs.total)); }
    }).catch(failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [connection?.id, page, reload, previewId, handoffId]);

  function locate(values: Record<string, string>) {
    setQuery(previous => { const next = new URLSearchParams(previous); for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); } return next; });
  }
  async function act(name: string, operation: (current: () => boolean) => Promise<void>) {
    if (busy) return; const attempt = ++generation.current; const current = () => alive.current && generation.current === attempt;
    setBusy(name); setError('');
    try { await operation(current); } catch (failure) { if (current()) setError(errorMessage(failure)); }
    finally { if (current()) setBusy(''); }
  }
  async function prepare() {
    if (!report || !canManage) return;
    await act('preview', async current => {
      const route = await ensureConnection(); if (!current()) return;
      const saved = await api.post<Preview>(`/connections/${route.id}/preview`, { report_id: report.id, expected_report_revision: report.revision });
      if (current()) { locate({ connection_id: route.id, preview_id: saved.id, handoff_id: '' }); setReload(value => value + 1); }
    });
  }
  async function approve() {
    if (!preview || !connection || !checked || !available || !canManage) return;
    await act('approve', async current => {
      const approval = await api.post<RecordItem>(`/connections/${connection.id}/approve`, { preview_id: preview.id, expected_checksum: preview.data.checksum }, { idempotencyKey: `approval-${preview.id}` });
      if (!current()) return;
      const saved = await api.post<Handoff>(`/connections/${connection.id}/handoff`, { approval_id: approval.id, expected_checksum: preview.data.checksum }, { idempotencyKey: `handoff-${approval.id}` });
      if (current()) { locate({ handoff_id: saved.id, preview_id: '', report_id: preview.data.binding.report_id }); setChecked(false); setReload(value => value + 1); }
    });
  }
  async function download(format: string, path: string) {
    const blob = await api.download(path); const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `FunkyFarm-records.${format}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <>
    {(error || loadError || reports.error || cases.error) && <Notice kind="error">{error || loadError || reports.error || cases.error}</Notice>}
    {!historyOnly && <section className="paper-section" aria-labelledby="connection-handoff"><h2 id="connection-handoff">Prepare files for the official website</h2><p>Choose an approved report, check its values and prepare your download.</p>
      <Field label="Issued report"><select value={reportId} disabled={!!busy || reports.loading} onChange={event => { locate({ report_id: event.target.value, preview_id: '', handoff_id: '' }); setPreview(null); setHandoff(null); }}><option value="">Choose an approved report</option>{issued.map(item => <option key={item.id} value={item.id}>{String(item.data.snapshot?.pack?.title || item.data.pack_id)} · {String(item.data.reporting_year)}</option>)}</select></Field>
      {!report && <p><Link to={`/app/reports?farm_id=${farm.id}`}>Prepare and approve a report</Link> first, or continue a field correction below.</p>}
      <Button disabled={!report || !canManage || !!busy} loading={busy === 'preview'} onClick={() => void prepare()}>Check the download</Button>
    </section>}
    {loading && <p role="status">Opening the saved paperwork…</p>}
    {preview && !loading && <section className="paper-section connection-review"><h2>Check before preparing the download</h2><p>Destination: {safeLink(preview.data.binding.official_url) ? <a href={safeLink(preview.data.binding.official_url)} target="_blank" rel="noopener noreferrer">Official website</a> : 'Check the official website'}. This check expires {dateText(preview.data.expires_at)}.</p>
      {!available && <Notice kind="warning">{preview.review_state?.reason || 'This check expired. Prepare a new download from the current approved report.'}</Notice>}
      <CopyFields key={preview.id} snapshot={preview.data.report_snapshot} reportId={preview.data.binding.report_id} available={available}/>
      <label className="check-row"><input type="checkbox" checked={checked} disabled={!available || !canManage || !!busy} onChange={event => setChecked(event.target.checked)}/>I checked the report and destination. Prepare these files; I will send them through the official website myself.</label>
      <Button disabled={!checked || !available || !canManage || !!busy} loading={busy === 'approve'} onClick={event => { if (event.nativeEvent.isTrusted) void approve(); }}>Approve and prepare my download</Button>
    </section>}
    {handoff && !loading && <section className="paper-section connection-result"><h2>Your prepared files</h2><p>Prepared {dateText(handoff.data.prepared_at)}. These are saved files; preparing them did not send an application.</p>
      {!handoffCurrent && <Notice kind="warning">{handoff.current_state?.reason || 'Check the current report before reusing this saved version.'} You can still download the retained version for your records.</Notice>}
      <div className="actions">{Object.entries(handoff.data.downloads).map(([format, path]) => <Button key={format} disabled={!!busy} onClick={() => void act(`download-${format}`, () => download(format, path))}>Download {format.toUpperCase()}</Button>)}</div>
      <CopyFields key={handoff.id} snapshot={handoff.data.report_snapshot} reportId={handoff.data.report_id} available={handoffCurrent}/>
      <ol className="connection-next-steps"><li>{safeLink(handoff.data.official_url) ? <a href={safeLink(handoff.data.official_url)} target="_blank" rel="noopener noreferrer">Open the official website and sign in</a> : 'Open the official website and sign in'}.</li><li>Use its current instructions to enter values or upload an accepted file. These report downloads are supporting records, not a verified portal import format.</li><li>Check the completed form, submit there and save the actual receipt.</li></ol>
      <p><Link to={`/app/reports/${handoff.data.report_id}#report-receipts`}>Save the delivery reference with this report</Link></p>
    </section>}
    <section className="paper-section connection-alternatives"><h2>Field corrections and case folders</h2><p>A field correction does not need a report first. Continue its guided case or use your reviewed boundary files.</p><div className="connection-link-grid"><Link to={`/app/fields/${farm.id}`}>Field changes and KML boundary downloads</Link><Link to={`/app/cases/new?${new URLSearchParams({ farm_id: farm.id, job_type: 'fields', reporting_year: String(farm.data.reporting_year || new Date().getFullYear()) })}`}>Prepare a field correction</Link></div>
      {cases.items.length > 0 && <ul className="connection-history-list">{cases.items.slice(0, 5).map(item => <li key={item.id}><div><strong>{String(item.data.title || 'Saved case')}</strong><small>{String(item.data.reporting_year)} · {String(item.data.status || 'Draft').replaceAll('_', ' ')}</small></div><Link to={`/app/cases/${item.id}`}>Continue case</Link></li>)}</ul>}{cases.items.length > 5 && <p><Link to={`/app/cases?farm_id=${farm.id}`}>Open all cases</Link></p>}
    </section>
    <section className="paper-section connection-history"><h2>Saved checks and downloads</h2>{!connection || !previews.length && !handoffs.length ? <p>No saved paperwork for this route yet.</p> : <div className="connection-history-columns"><div><h3>Prepared downloads</h3><ul className="connection-history-list">{handoffs.map(item => <li key={item.id}><span>{dateText(item.data.prepared_at)}</span><Button variant="ghost" disabled={!!busy} onClick={() => locate({ connection_id: connection.id, handoff_id: item.id, preview_id: '' })}>Open files</Button></li>)}</ul></div><div><h3>Earlier checks</h3><ul className="connection-history-list">{previews.map(item => <li key={item.id}><span>{dateText(item.created_at)}<small>{Date.parse(item.data.expires_at) <= Date.now() ? 'Expired; open to see the saved version' : 'Open to check whether it is still current'}</small></span><Button variant="ghost" disabled={!!busy} onClick={() => locate({ connection_id: connection.id, preview_id: item.id, handoff_id: '' })}>Open check</Button></li>)}</ul></div></div>}
      {total > 5 && <div className="actions"><Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer paperwork</Button><Button variant="secondary" disabled={(page + 1) * 5 >= total} onClick={() => setPage(page + 1)}>Older paperwork</Button></div>}
    </section>
  </>;
}
