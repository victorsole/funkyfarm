import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Loading, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import type { RecordItem } from '../types';
import './funding.css';

type Programme = {
  id: string; title: string; description: string; relationship_to_cap: string;
  applicant_summary: string; applicant_types: string[]; applicant_limits: string;
  programme_models: { id: string; description: string }[];
  call_2026: { status: string; status_label: string; deadline_qualification: string };
  future_calls: { message: string };
  official_links: { url: string; title: string; purpose: string }[];
  sources: { id: string; url: string; title: string; edition: string; checked_date: string }[];
  limitations: string[];
};
type SourceCheck = { source_id: string; title: string; url: string; status: string; baseline_exists: boolean; last_checked_at: string | null; last_successful_at?: string | null; next_check_at?: string | null; freshness?: string };
type Guide = { farm: { id: string; name: string; country_name: string }; checked_date: string; version: string; items: Programme[]; source_checks: SourceCheck[]; questions: { id: string; title: string; message: string }[]; personalised_eligibility: false; application_enabled: false };

function OfficialLink({ url, children }: { url: string; children: ReactNode }) {
  try { const parsed = new URL(url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && ['rea.ec.europa.eu', 'ec.europa.eu'].includes(parsed.hostname)) return <a href={parsed.href} target="_blank" rel="noreferrer">{children}</a>; } catch { /* An incomplete installed source remains readable without a link. */ }
  return <span>{children}</span>;
}
function dateTime(value?: string | null) { return value ? new Date(value).toLocaleString() : 'Not checked yet'; }
function statusText(source: SourceCheck) {
  if (source.freshness === 'failed') return source.baseline_exists ? 'The last attempt failed. The earlier successful check is still shown.' : 'We could not check the official page. No successful check is saved yet.';
  if (!source.baseline_exists) return 'Waiting for the first successful check.';
  if (source.freshness === 'stale') return 'The last successful check is older than expected.';
  if (source.status === 'changed') return 'The official page changed. Read the update before acting.';
  return 'A successful page check is saved. Open updates to compare recorded changes.';
}

function FundingForFarm({ farmId }: { farmId: string }) {
  const { session } = useSession();
  const [guide, setGuide] = useState<Guide | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [reminder, setReminder] = useState('');
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState<RecordItem | null>(null);
  const request = useRef<{ body: string; key: string } | null>(null);
  const mounted = useRef(true);
  const tasks = useRecords(`tasks?farm_id=${encodeURIComponent(farmId)}&task_state=active`);
  const canWrite = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true; setError('');
    api.get<Guide>(`/farms/${encodeURIComponent(farmId)}/funding-guide`).then(value => {
      if (value.farm?.id !== farmId || !Array.isArray(value.items) || !Array.isArray(value.source_checks) || !Array.isArray(value.questions) || value.personalised_eligibility !== false || value.application_enabled !== false) throw new Error('The funding guide could not be read. Try again.');
      if (active) setGuide(value);
    }).catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [farmId, attempt]);
  const existing = saved ?? tasks.items.find(task => task.data.title === 'Check agricultural promotion funding' && typeof task.data.description === 'string' && task.data.description.includes('REA AGRIP'));
  async function saveReminder(event: FormEvent) {
    event.preventDefault();
    if (!guide || existing || busy || !canWrite || tasks.loading || tasks.error) return;
    setError(''); setBusy(true);
    const body = { data: { farm_id: farmId, title: 'Check agricultural promotion funding', description: `REA AGRIP: review the current call and organisation eligibility before preparing any application. ${guide.items[0]?.official_links[0]?.url ?? ''}`, status: 'open', ...(reminder ? { due_date: reminder } : {}), ...(note.trim() ? { notes: note.trim() } : {}) } };
    const signature = JSON.stringify(body);
    if (request.current?.body !== signature) request.current = { body: signature, key: crypto.randomUUID() };
    try { const result = await api.post<RecordItem>('/tasks', body, { idempotencyKey: request.current.key }); if (mounted.current) { setSaved(result); request.current = null; } }
    catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <div className="funding-page">
    {error && <Notice kind="error">{error}<div><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Try again</Button></div></Notice>}
    {!guide && !error && <Loading>Opening funding information…</Loading>}
    {guide && <>
      <p className="muted">For {guide.farm.name} · {guide.farm.country_name}. General funding guidance checked {guide.checked_date}.</p>
      {guide.items.map(item => <article className="card funding-programme" key={item.id}>
        <div className="section-heading"><h2>{item.title}</h2><span className="badge">2026 applications closed</span></div>
        <p>{item.description}</p><p>{item.relationship_to_cap}</p>
        <div className="funding-call"><strong>{item.call_2026.status_label}</strong><p>{item.future_calls.message}</p><p className="muted">These are saved call details, not a live opening or an application deadline for your farm.</p></div>
        <h3>Is it worth looking into?</h3><p>{item.applicant_summary}</p><ul>{item.applicant_types.map(type => <li key={type}>{type}</li>)}</ul><p>{item.applicant_limits}</p>
        <div className="actions">{item.official_links.map(link => <OfficialLink key={link.url} url={link.url}>{link.title}</OfficialLink>)}</div>
        <h3>Before you prepare anything</h3><ol className="funding-steps">{guide.questions.map(question => <li key={question.id}><strong>{question.title}</strong><p>{question.message}</p></li>)}</ol>
        <p className="muted">Your eligibility has not been assessed. The official call decides what can be funded.</p>
      </article>)}
      <section className="card"><h2>Watch for changes</h2><p>The server checks the official AGRIP page daily when source monitoring is enabled. A changed page is a reason to read it, not proof that a new call has opened.</p>
        {guide.source_checks.length ? <ul className="funding-source-list">{guide.source_checks.map(source => <li key={source.source_id}><h3>{source.title}</h3><p>{statusText(source)}</p><dl className="funding-dates"><div><dt>Last successful check</dt><dd>{dateTime(source.last_successful_at)}</dd></div><div><dt>Last attempt</dt><dd>{dateTime(source.last_checked_at)}</dd></div><div><dt>Next scheduled attempt</dt><dd>{source.next_check_at ? dateTime(source.next_check_at) : 'Not scheduled yet'}</dd></div></dl><OfficialLink url={source.url}>Read the official page</OfficialLink></li>)}</ul> : <p>No funding source checks are available yet.</p>}
        <div className="actions"><Link className="button button-secondary" to={`/app/updates?farm_id=${encodeURIComponent(farmId)}&family=funding`}>Read funding updates</Link><Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Refresh saved check status</Button></div>
      </section>
      <section className="card"><h2>Keep a follow-up</h2><p>Save a task for yourself or your adviser. It appears in this farm's task list. You choose the follow-up date; it is not a grant deadline.</p>
        {tasks.error && <Notice kind="error">{tasks.error}<Button variant="ghost" onClick={() => void tasks.reload()}>Reload tasks</Button></Notice>}
        {tasks.loading ? <Loading>Checking existing follow-ups…</Loading> : existing ? <Notice kind="success">A follow-up task is saved for this farm. <Link to={`/app/tasks/${existing.id}`}>Open the task</Link></Notice> : canWrite ? <form className="stack" onSubmit={saveReminder}><Field label="Follow-up date (optional)"><input type="date" value={reminder} onChange={event => setReminder(event.target.value)} disabled={busy}/></Field><Field label="What should we check? (optional)"><textarea value={note} maxLength={4000} onChange={event => setNote(event.target.value)} placeholder="For example, ask our producer group whether it can apply." disabled={busy}/></Field><div><Button type="submit" loading={busy} disabled={!!tasks.error}>Save funding follow-up</Button></div></form> : <p>Ask the farm owner or an adviser with permission to save a follow-up.</p>}
      </section>
      <section className="funding-footnote"><h2>Sources and programme details</h2>{guide.items.map(item => <div key={item.id}><ul>{item.programme_models.map(model => <li key={model.id}><strong>{model.id}:</strong> {model.description}</li>)}</ul><ul>{item.sources.map(source => <li key={source.id}><OfficialLink url={source.url}>{source.title}</OfficialLink><p>{source.edition}</p></li>)}</ul><p>{item.limitations.join(' ')}</p></div>)}<p>Source: European Research Executive Agency / European Union, reused under CC BY 4.0. Summaries and follow-up guidance are by Funkyfarm. Guide {guide.version}.</p></section>
    </>}
  </div>;
}

export function FundingPage() {
  const farms = useRecords('farms');
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const farmId = params.get('farm_id') || (farms.items.length === 1 ? farms.items[0].id : '');
  return <><PageHeader title="Funding and grants" description="Check organisation funding, read official updates and keep a useful next step." action={<Link className="button button-secondary" to="/app/tools">All farm tools</Link>}/><section className="card"><Field label="Which farm?"><select value={farmId} onChange={event => setParams(event.target.value ? { farm_id: event.target.value } : {})}><option value="">Choose a farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field>{farms.error && <Notice kind="error">{farms.error}</Notice>}{farms.loading && <Loading>Opening farms…</Loading>}{!farmId && !farms.loading && <p>Choose a farm to keep its funding follow-up in the right place.</p>}</section>{farmId && <FundingForFarm key={`${session?.user.id}:${session?.workspace.id}:${farmId}`} farmId={farmId}/>}</>;
}
