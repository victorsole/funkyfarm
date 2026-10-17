import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Notice } from '../components';

type Data = Record<string, unknown>;
export const PORTUGUESE_JOURNAL_PACK = 'pt-ppp-surface-journal';
export const PORTUGUESE_JOURNAL_KEY = 'pt.ppp.surface_journal';
export const portugueseJournalPath = (farmId: string, context: Record<string, string> = {}) => `/app/record-work?${new URLSearchParams({ farm_id: farmId, ...context })}#portuguese-journal`;
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : [];
const literal = (value: unknown) => value == null ? 'Not recorded' : value === '' ? 'Left blank' : typeof value === 'string' && !value.trim() ? `Spaces or line breaks only (${value.length} characters)` : text(value);
const exclusionReasons: Record<string, string> = { date_missing: 'Actual date not recorded', date_unconfirmed: 'Actual date not checked', future_date: 'Date is in the future', different_year: 'A different year was recorded', not_selected: 'Not selected' };
const exclusionReason = (value: unknown) => exclusionReasons[text(value)] || 'Needs checking';
function safeSource(value: unknown) {
  try { const url = new URL(text(value)); return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null; } catch { return null; }
}

export function RetainedPortugueseJournals({ journals, farmId }: { journals: unknown; farmId: string }) {
  return <>{list(journals).filter(journal => journal.schema_id === 'pt-ppp-surface-v1').map((journal, index) => <Journal key={index} journal={journal} farmId={farmId} />)}</>;
}

function Journal({ journal, farmId }: { journal: Data; farmId: string }) {
  const [page, setPage] = useState(0);
  const columns = list(journal.columns); const entries = list(journal.entries); const excluded = list(journal.excluded_entries);
  const holder = object(journal.holder); const source = object(journal.source); const sourceURL = safeSource(source.url);
  const pageCount = Math.max(1, Math.ceil(entries.length / 16)); const start = Math.min(page, pageCount - 1) * 16;
  const keys = columns.map(column => text(column.key));
  if (columns.length !== 13 || new Set(keys).size !== 13 || keys.some(key => !key)
    || entries.some(entry => keys.some(key => !Object.hasOwn(object(entry.values), key)))) {
    return <Notice kind="error">The saved Portuguese record cannot be shown completely. Do not approve it from this preview; reload it or ask for help.</Notice>;
  }
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const factId = text(holder.fact_id); const revision = holder.fact_revision;
  const sourcePath = uuid.test(farmId) && uuid.test(factId) && typeof revision === 'number' && Number.isInteger(revision) && revision > 0
    ? `/app/record-work?${new URLSearchParams({ farm_id: farmId, pt_journal_fact: factId, pt_journal_fact_revision: String(revision) })}#portuguese-journal` : null;
  return <section className="paper-section" aria-label="Saved Portuguese crop-protection record">
    <h3>Portuguese crop-protection record</h3>
    <p>{text(journal.capability_notice)}</p>
    <dl className="detail-grid"><div><dt>Producer or business</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{literal(holder.value)}</dd></div><div><dt>Year selected for this report</dt><dd>{String(journal.reporting_year ?? 'Not selected')}</dd></div></dl>
    <p>This is the saved report version. Later edits to your journal do not replace these rows.{sourcePath && <> <Link to={sourcePath}>Open the source journal</Link>.</>}</p>
    <h4>{entries.length} selected {entries.length === 1 ? 'row' : 'rows'}</h4>
    {entries.slice(start, start + 16).map((entry, offset) => <details className="card" key={text(entry.entry_id)}>
      <summary>Row {start + offset + 1}{entry.actual_date ? `, ${text(entry.actual_date)}` : ''}</summary>
      <dl className="evidence-list">{columns.map(column => <div key={text(column.key)}><dt style={{ whiteSpace: 'pre-wrap' }}>{text(column.label)}</dt><dd style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{literal(object(entry.values)[text(column.key)])}</dd></div>)}</dl>
      {list(entry.issues).map((issue, index) => <p key={index}>{text(issue.message)}</p>)}
    </details>)}
    {pageCount > 1 && <div className="actions" aria-label="Saved journal row pages"><Button variant="secondary" disabled={start === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous rows</Button><span>Rows {entries.length ? start + 1 : 0} to {Math.min(start + 16, entries.length)} of {entries.length}</span><Button variant="secondary" disabled={start + 16 >= entries.length} onClick={() => setPage(value => value + 1)}>Next rows</Button></div>}
    <section><h4>Notes for the whole record</h4><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{literal(journal.observations_text)}</p></section>
    {!!excluded.length && <details><summary>{excluded.length} source {excluded.length === 1 ? 'row was' : 'rows were'} not included</summary><p>These rows remain in the source journal. They are not silently assigned a date or included in this report.</p><ul>{excluded.map((entry, index) => <li key={text(entry.entry_id) || index}>{exclusionReason(entry.reason)}{entry.actual_date ? `, supplied date ${text(entry.actual_date)}` : ''}<small className="muted"> Source row {text(entry.entry_id)}</small></li>)}</ul></details>}
    <details><summary>Template and saved versions</summary><p>{sourceURL ? <a href={sourceURL} target="_blank" rel="noreferrer">{text(source.title) || 'DGAV record template'}</a> : text(source.title)}</p><p>{text(source.edition)}</p><p>Source journal version {String(revision ?? 'unknown')}. Template SHA-256: {text(source.sha256)}</p><ul>{entries.map(entry => <li key={text(entry.entry_id)}>Row {text(entry.entry_id)}, source journal version {String(entry.source_fact_revision ?? revision ?? 'unknown')}</li>)}</ul></details>
  </section>;
}
