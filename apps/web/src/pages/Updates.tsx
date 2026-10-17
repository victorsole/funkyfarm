import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { Button, Field, Loading, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import type { RecordItem } from '../types';
import './updates.css';

type SourceCheck = { source_id: string; title: string; url: string; status: string; freshness: 'current' | 'stale' | 'failed' | 'never_checked'; last_checked_at: string | null; last_successful_at: string | null; next_check_at: string | null };
type ReviewData = { outcome: string; note: string; reviewed_at: string; task_id: string | null };
type Review = RecordItem & { data: ReviewData };
type Update = { id: string; title: string; url: string; detected_at: string; is_read: boolean; review?: Review | null; families: string[] };
type Updates = { items: Update[]; total: number; unread_count: number; limit: number; offset: number; preferences: { revision: number; enabled: boolean; families: string[]; read_event_ids: string[] }; monitor: { enabled: boolean; source_count: number; current_count: number; stale_count: number; error_count: number }; source_checks: SourceCheck[] };
type Detail = { farm_id: string; farm_name: string; event: Update; source_check: SourceCheck; review: Review | null; task: RecordItem | null; can_review: boolean; comparison: { available: boolean; passages: Array<{ before: string; after: string }>; before: string | null; after: string | null; truncated: boolean } };
const TOPICS = [['', 'All topics'], ['cap', 'CAP and field claims'], ['inputs', 'Crop protection'], ['annual', 'Farm records'], ['inspection', 'Inspections'], ['sustainability', 'Environment'], ['funding', 'Funding']] as const;
const STATUS = { current: 'Checked recently', stale: 'Check overdue', failed: 'Could not check', never_checked: 'Not checked yet' };
const OUTCOMES: Record<string, string> = { needs_action: 'Work needed', not_relevant: 'Does not affect this farm', reviewed: 'Checked, no work needed' };
const when = (stamp: string) => new Date(stamp).toLocaleString();
function sourceLink(url: string) { try { return new URL(url).protocol === 'https:' ? url : undefined; } catch { return undefined; } }

function SourceStatus({ source }: { source: SourceCheck }) {
  return <div className="update-source-status"><span className={`update-status is-${source.freshness}`}>{STATUS[source.freshness]}</span><p>{source.last_successful_at ? `Last successful check: ${when(source.last_successful_at)}.` : 'No successful check date is available yet.'}</p>{source.freshness !== 'current' && source.next_check_at && <p>Next attempt: {when(source.next_check_at)}.</p>}</div>;
}

export function UpdatesPage() {
  const farms = useRecords('farms');
  const [search, setSearch] = useSearchParams();
  const farmId = search.get('farm_id') ?? '';
  const family = search.get('family') ?? '';
  const offset = Math.max(0, Number(search.get('offset')) || 0);
  const [data, setData] = useState<Updates | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const [showSources, setShowSources] = useState(false);
  const query = `farm_id=${encodeURIComponent(farmId)}&limit=20&offset=${offset}${family ? `&family=${encodeURIComponent(family)}` : ''}`;
  useEffect(() => {
    let active = true;
    setData(null); setError(''); setMessage(''); setLoading(!!farmId);
    if (farmId) api.get<Updates>(`/regulatory/updates?${query}`).then(value => { if (active) setData(value); }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [farmId, query, version]);
  function choose(values: Record<string, string>) { const next = new URLSearchParams(search); for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key); setSearch(next); }
  async function preference(enabled: boolean, readIds: string[]) {
    if (!data || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api.post('/regulatory/preferences', { farm_id: farmId, expected_revision: data.preferences.revision, enabled, families: data.preferences.families, read_event_ids: readIds });
      setData(await api.get<Updates>(`/regulatory/updates?${query}`));
      setMessage('Your in-app update preference is saved.');
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <div className="updates-page">
    <PageHeader title="Updates from official websites" description="Check what changed and keep track of anything you need to do." action={<Link className="button button-secondary" to={`/app/checks${farmId ? `?farm_id=${farmId}` : ''}`}>Farm checks</Link>} />
    <section className="panel update-filters"><Field label="Which farm?"><select disabled={busy} value={farmId} onChange={event => choose({ farm_id: event.target.value, offset: '' })}><option value="">Choose a farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field><Field label="Topic"><select disabled={busy} value={family} onChange={event => choose({ family: event.target.value, offset: '' })}>{TOPICS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></section>
    {farms.loading && <Loading>Opening farms…</Loading>}{farms.error && <Notice kind="error">{farms.error}</Notice>}
    {!farmId && !farms.loading && <Notice>Choose your farm to see its updates.</Notice>}
    {loading && <Loading>Opening updates…</Loading>}{error && <Notice kind="error">{error}<Button variant="ghost" onClick={() => setVersion(value => value + 1)}>Try again</Button></Notice>}{message && <Notice kind="success">{message}</Notice>}
    {data && <>
      <section className="panel update-watch"><div><h2>{data.monitor.current_count} of {data.monitor.source_count} pages checked recently</h2><p>{data.monitor.error_count ? `${data.monitor.error_count} could not be checked. ` : ''}{data.monitor.stale_count ? `${data.monitor.stale_count} checks are overdue. ` : ''}{!data.monitor.enabled ? 'Automatic checks are switched off on this server.' : 'Pages are checked automatically. You do not need to leave this page open.'}</p></div><Button variant="secondary" onClick={() => setShowSources(value => !value)} aria-expanded={showSources} aria-controls="update-sources">{showSources ? 'Hide sources' : 'View sources'}</Button></section>
      {showSources && <section className="panel" id="update-sources"><h2>Sources for this farm</h2><ul className="update-source-list">{data.source_checks.map(source => <li key={source.source_id}><h3>{source.title}</h3><SourceStatus source={source} /><a href={sourceLink(source.url)} target="_blank" rel="noreferrer">Open official page</a></li>)}</ul></section>}
      <section className="panel"><div className="section-heading"><h2>{data.unread_count} unread source changes</h2><Button variant="ghost" onClick={() => setVersion(value => value + 1)}>Refresh list</Button></div><p className="update-note">A changed web page does not by itself establish a changed legal duty. We do not change your records or deadlines automatically.</p>{!data.items.length && <p className="empty-state">{data.preferences.enabled ? 'No matching changes are recorded. This does not mean every rule is unchanged.' : 'Updates are hidden. Switch them on below to see recorded changes.'}</p>}<div className="update-feed">{data.items.map(update => <article key={update.id}><div className="section-heading"><h3><Link to={`/app/updates/${update.id}?farm_id=${farmId}`}>{update.title}</Link></h3><span className="badge">{update.review ? OUTCOMES[update.review.data.outcome] : update.is_read ? 'Read, not reviewed' : 'New'}</span></div><p>Page change found {when(update.detected_at)}.</p><div className="actions"><Link className="button button-secondary" to={`/app/updates/${update.id}?farm_id=${farmId}`}>See what changed</Link>{!update.is_read && <Button variant="ghost" disabled={busy} onClick={() => void preference(data.preferences.enabled, [...new Set([...data.preferences.read_event_ids, update.id])].slice(-500))}>Mark as read</Button>}</div></article>)}</div>{data.total > data.limit && <nav className="actions" aria-label="Update pages"><Button variant="secondary" disabled={!offset} onClick={() => choose({ offset: String(Math.max(0, offset - data.limit)) })}>Previous</Button><span>{offset + 1}–{Math.min(offset + data.limit, data.total)} of {data.total}</span><Button variant="secondary" disabled={offset + data.limit >= data.total} onClick={() => choose({ offset: String(offset + data.limit) })}>Next</Button></nav>}</section>
      <section className="panel"><label className="check-row"><input type="checkbox" checked={data.preferences.enabled} disabled={busy} onChange={event => void preference(event.target.checked, data.preferences.read_event_ids)} />Show relevant source changes inside my farm workspace</label><p className="update-note">In-app updates only. This watches the listed pages, not every new law or funding call.</p></section>
    </>}
  </div>;
}

export function UpdateDetailPage() {
  const { updateId = '' } = useParams();
  const [search] = useSearchParams();
  const farmId = search.get('farm_id') ?? '';
  return <UpdateDetail key={`${farmId}/${updateId}`} farmId={farmId} updateId={updateId} />;
}

function UpdateDetail({ farmId, updateId }: { farmId: string; updateId: string }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState('needs_action');
  const [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState(false);
  const [dueDate, setDueDate] = useState('');
  const [showExtract, setShowExtract] = useState(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const path = `/regulatory/updates/${encodeURIComponent(updateId)}?farm_id=${encodeURIComponent(farmId)}`;
  useEffect(() => {
    let active = true;
    if (!farmId || !updateId) { setError('Choose a farm and an update from the updates page.'); return; }
    setError('');
    api.get<Detail>(path).then(value => {
      if (!active) return;
      setData(value); setOutcome(value.review?.data.outcome ?? 'needs_action'); setNote(value.review?.data.note ?? '');
    }).catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [farmId, updateId, path, version]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!data || busy) return;
    const payload = { farm_id: farmId, expected_revision: data.review?.revision ?? 0, outcome, note, create_follow_up: outcome === 'needs_action' && followUp, due_date: outcome === 'needs_action' && followUp && dueDate ? dueDate : null };
    const signature = JSON.stringify(payload);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true); setError(''); setMessage('');
    try {
      await api.post(`/regulatory/updates/${encodeURIComponent(updateId)}/review`, payload, { idempotencyKey: attempt.current.key });
      setData(await api.get<Detail>(path)); setMessage('Review saved. Your other farm records have not changed.'); attempt.current = null; setFollowUp(false); setDueDate('');
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <div className="updates-page"><PageHeader title={data?.event.title ?? 'Review an update'} description={data ? `For ${data.farm_name}` : 'Read the change before deciding what to do.'} action={<Link className="button button-secondary" to={`/app/updates${farmId ? `?farm_id=${farmId}` : ''}`}>All updates</Link>} />
    {error && <Notice kind="error">{error}<Button variant="ghost" onClick={() => setVersion(value => value + 1)}>Reload saved review</Button></Notice>}{message && <Notice kind="success">{message}</Notice>}{!data && !error && <Loading>Opening this update…</Loading>}
    {data && <>
      <section className="panel"><div className="section-heading"><h2>Read what changed</h2><a className="button button-secondary" href={sourceLink(data.event.url)} target="_blank" rel="noreferrer">Open official page</a></div><p>Page change found {when(data.event.detected_at)}. This is not yet a confirmed change to your legal duties.</p><SourceStatus source={data.source_check} />
        {!data.comparison.available ? <Notice>The earlier and later page text is not available for this change. Read the official page before recording a review.</Notice> : !data.comparison.passages.length ? <Notice>No difference was found in the saved readable extracts. The page layout or text outside these extracts may have changed.</Notice> : <div className="update-comparisons">{data.comparison.passages.map((passage, index) => <div className="update-comparison" key={index}><section><h3>Earlier text</h3><p>{passage.before || 'No earlier text in this section.'}</p></section><section><h3>Later text</h3><p>{passage.after || 'This section was removed.'}</p></section></div>)}</div>}
        {data.comparison.truncated && <p className="update-note">Only part of the page was saved. Check the official page for the full text.</p>}{data.comparison.after && <><Button variant="ghost" onClick={() => setShowExtract(value => !value)} aria-expanded={showExtract} aria-controls="saved-update-text">{showExtract ? 'Hide saved text' : 'Read saved text'}</Button>{showExtract && <p className="update-extract" id="saved-update-text">{data.comparison.after}</p>}</>}
      </section>
      <section className="panel"><h2>What does this mean for your farm?</h2><p>Check the page with your adviser if you are unsure. Saving this review does not update an official rule, legal deadline or issued form.</p><div className="actions"><Link to={`/app/checks?farm_id=${farmId}`}>Open farm checks</Link><Link to={`/app/community?farm_id=${farmId}`}>Ask for help</Link></div>{data.review && <p className="update-note">Last review: {OUTCOMES[data.review.data.outcome]}, {when(data.review.data.reviewed_at)}.</p>}
        {data.task && <Notice>Follow-up saved: <Link to={`/app/tasks/${data.task.id}`}>{data.task.data.title}</Link>. Its target date is your working date, not a newly verified legal deadline.</Notice>}
        {!data.can_review ? <Notice>Your farm access is read-only. Ask the owner or an adviser with review access to save a decision.</Notice> : <form className="stack update-review-form" onSubmit={save}><fieldset disabled={busy}><legend>Your review</legend><Field label="Does this need work?"><select value={outcome} onChange={event => setOutcome(event.target.value)}>{Object.entries(OUTCOMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="What did you check, and what needs doing?"><textarea required minLength={10} maxLength={4000} rows={4} value={note} onChange={event => setNote(event.target.value)} placeholder="For example: I checked the notice with our adviser. We need to update the field record." /></Field>{outcome === 'needs_action' && !data.task && <><label className="check-row"><input type="checkbox" checked={followUp} onChange={event => setFollowUp(event.target.checked)} />Add this to my tasks</label>{followUp && <Field label="When do you want to do this? (optional)"><input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} /></Field>}</>}<Button type="submit" loading={busy}>Save review</Button></fieldset></form>}
      </section>
    </>}
  </div>;
}
