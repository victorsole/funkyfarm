import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Loading, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { usePrivateDraft } from '../offline';
import type { RecordItem } from '../types';
import './administration.css';

type Source = { title?: string; url?: string; edition?: string; checked_at?: string };
type Step = { id: string; title: string; message?: string; status?: string; href?: string; kind?: string };
type Obligation = { id: string; title: string; workflow_id: string; applicability: 'applies' | 'does_not_apply' | 'unknown' | 'conflict'; status: string; requirements: Array<{ id: string; label: string; status: string; issues?: Array<string | { message: string }>; steps?: Step[] }>; deadline: { status: string; date: string | null; message: string }; citations: Source[]; progress: { required: number; with_evidence: number; needs_review: number }; steps: Step[]; limits: string[] };
type ProfileQuestion = { key: string; fact_key: string; label: string; prompt: string; value_type: string; choices: Array<{ value: string; label: string }>; sources: Source[]; conflicting_fact_ids: string[]; proposal_ids: string[] };
type Checks = { farm_id: string; farm_revision: number; year: number; rules_version: string; rules_updated_at: string; profile_questions: ProfileQuestion[]; obligations: Obligation[]; issues: Array<{ code: string; severity: string; message: string; href?: string }>; overall: string; limits: string[] };
type Update = { id: string; title: string; url: string; country: string; region?: string; detected_at: string; effective_date: string | null; is_read: boolean; notice: string; source_edition?: string | null; required_action?: string; relevance?: string; rule_ids?: string[] };
type Updates = { items: Update[]; total: number; unread_count: number; preferences: { revision: number; enabled: boolean; families: string[]; read_event_ids: string[] }; monitor: { enabled: boolean; source_count: number; checked_count: number; baseline_count?: number; pending_count: number; error_count: number; last_checked_at: string | null; meaning?: string }; source_checks?: Array<{ source_id: string; title: string; url: string; status: string; baseline_exists: boolean; last_checked_at: string | null }>; notice: string };

function sourceUrl(value?: string) {
  if (!value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function localHref(value?: string) { return value?.startsWith('/app/') && !value.includes('\\') ? value : null; }
function Sources({ items }: { items: Source[] }) {
  return items.length ? <ul className="admin-source-list">{items.map((source, index) => <li key={index}>{sourceUrl(source.url) ? <a href={sourceUrl(source.url)!} target="_blank" rel="noreferrer">{source.title || 'Open official source'}</a> : <span>{source.title || 'Source reference'}</span>}{source.edition && <span> · {source.edition}</span>}</li>)}</ul> : <p className="muted">No source link has been supplied for this check.</p>;
}
function Steps({ items }: { items: Step[] }) {
  return items.length ? <ol className="admin-step-list">{items.map(step => <li key={step.id}><strong>{step.title}</strong>{step.message && <p>{step.message}</p>}{localHref(step.href) && <Link to={localHref(step.href)!}>Open this step</Link>}</li>)}</ol> : null;
}
function useFarmChoice() {
  const farms = useRecords('farms');
  const [search, setSearch] = useSearchParams();
  const farmId = search.get('farm_id') ?? '';
  const year = search.get('year') ?? String(new Date().getFullYear());
  function choose(id: string, nextYear = year) { setSearch({ ...(id ? { farm_id: id } : {}), year: nextYear }); }
  return { farms, farmId, year, choose };
}

type ProfileDraft = { answers: Record<string, string | string[]>; proposals: RecordItem[]; notes: Record<string, string> };

function ProfileAnswers({ data, canReview, onSaved }: { data: Checks; canReview: boolean; onSaved: () => void }) {
  const draft = usePrivateDraft<ProfileDraft>(`checks/profile/${data.farm_id}/${data.year}`, { answers: {}, proposals: [], notes: {} });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notices, setNotices] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  function answer(key: string, value: string | string[]) {
    draft.setValue(previous => ({ ...previous, answers: { ...previous.answers, [key]: value } }));
  }
  function displayValue(value: unknown) {
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return value.map(item => String(item).replaceAll('_', ' ')).join(', ');
    return String(value ?? 'Not supplied').replaceAll('_', ' ');
  }
  async function saveAnswers(event: FormEvent) {
    event.preventDefault(); setError(''); setNotices([]); setSaving(true);
    try {
      const answers = data.profile_questions.flatMap<{ key: string; value: boolean | string | string[] }>(question => {
        const key = question.fact_key || question.key;
        const value = draft.value.answers[key];
        if (value === undefined || value === '' || Array.isArray(value) && !value.length) return [];
        if (question.value_type === 'boolean') {
          if (value !== 'yes' && value !== 'no') throw new Error('Choose Yes, No or Not known yet for each farm question.');
          return [{ key, value: value === 'yes' }];
        }
        return [{ key, value }];
      });
      if (!answers.length) throw new Error('Answer at least one question you know. Leave the others as Not known yet.');
      const body = { year: data.year, expected_farm_revision: data.farm_revision, answers };
      const signature = JSON.stringify(body);
      if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
      const result = await api.post<{ facts: RecordItem[]; notices: string[] }>(`/compliance/farms/${data.farm_id}/profile`, body, { idempotencyKey: attempt.current.key });
      draft.setValue(previous => ({ ...previous, answers: {}, proposals: [...new Map<string, RecordItem>([...previous.proposals, ...result.facts].map(fact => [fact.id, fact] as const)).values()] }));
      setNotices([result.facts.length ? 'Step 1 is saved. These answers are proposed, not confirmed. Read each saved answer below before confirming it.' : 'No new proposed answers were created.', ...result.notices]);
      attempt.current = null; onSaved();
    } catch (failure) { setError(errorMessage(failure)); } finally { setSaving(false); }
  }
  async function review(fact: RecordItem) {
    if (!checked[fact.id]) return;
    setReviewing(fact.id); setReviewErrors(previous => ({ ...previous, [fact.id]: '' }));
    try {
      const saved = await api.post<RecordItem>(`/facts/${fact.id}/review`, { expected_revision: fact.revision, decision: 'confirmed', note: draft.value.notes[fact.id] || '' });
      draft.setValue(previous => ({ ...previous, proposals: previous.proposals.map(item => item.id === saved.id ? saved : item) }));
      setChecked(previous => ({ ...previous, [fact.id]: false })); onSaved();
    } catch (failure) { setReviewErrors(previous => ({ ...previous, [fact.id]: errorMessage(failure) })); } finally { setReviewing(null); }
  }
  return <section className="panel admin-section"><h2>First, a few things about this farm</h2><p>Answer what you know for {data.year}. Saving makes proposed answers. Confirming them is a separate step after you read them back.</p>
    {error && <Notice kind="error">{error}</Notice>}{draft.error && <Notice kind="warning">{draft.error}</Notice>}{draft.saving && <p role="status" className="muted">Keeping your unsaved answers in a private draft…</p>}{notices.map((notice, index) => <Notice key={index}>{notice}</Notice>)}
    {!draft.ready ? <Loading>Opening your farm answers…</Loading> : <>
      {!data.profile_questions.length && !draft.value.proposals.length && <p className="muted">No unanswered farm-profile questions were identified by the current rules. Other checks below may still need evidence.</p>}
      {data.profile_questions.length > 0 && <form className="stack" onSubmit={saveAnswers}><h3>1. Answer the farm questions</h3>{data.profile_questions.map(question => {
        const key = question.fact_key || question.key;
        const value = draft.value.answers[key];
        const multiple = ['ppp_use_type', 'registry_species'].includes(key) && question.choices.length > 0;
        return <div className="admin-check" key={key}>{question.conflicting_fact_ids.length > 0 && <Notice kind="warning">Different confirmed answers are already recorded for this question. Compare them with your sources before adding another answer.</Notice>}
          {canReview ? multiple ? <fieldset disabled={saving}><legend>{question.label}</legend><p className="admin-footnote">Choose every type that applies. Leave these blank if not known yet.</p>{question.choices.map(choice => <label className="check-row" key={choice.value}><input type="checkbox" checked={Array.isArray(value) && value.includes(choice.value)} onChange={event => answer(key, event.target.checked ? [...(Array.isArray(value) ? value : []), choice.value] : (Array.isArray(value) ? value : []).filter(item => item !== choice.value))}/>{choice.label}</label>)}</fieldset> : <Field label={question.label}>{question.value_type === 'boolean' ? <select disabled={saving} value={typeof value === 'string' ? value : ''} onChange={event => answer(key, event.target.value)}><option value="">Not known yet</option><option value="yes">Yes</option><option value="no">No</option></select> : question.choices.length ? <select disabled={saving} value={typeof value === 'string' ? value : ''} onChange={event => answer(key, event.target.value)}><option value="">Not known yet</option>{question.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : <input disabled={saving} value={typeof value === 'string' ? value : ''} onChange={event => answer(key, event.target.value)} placeholder="Leave blank if not known yet"/>}</Field> : <h4>{question.label}</h4>}
          <details><summary>Why is this being asked?</summary><p>{question.prompt}</p><Sources items={question.sources}/></details>
        </div>;
      })}{canReview ? <div><Button type="submit" loading={saving}>Save answers for review</Button></div> : <Notice>Ask the farm owner or an adviser with review permission to answer these questions.</Notice>}</form>}
      {draft.value.proposals.length > 0 && <div className="admin-subsection"><h3>2. Read and confirm each saved answer</h3><p>Confirm only answers you have checked. Other answers stay proposed, including when one review fails.</p>{draft.value.proposals.map(fact => <article className="admin-check" key={fact.id}><h4>{String(fact.data.label || 'Farm answer')}</h4><p><strong>{displayValue(fact.data.value)}</strong> · reporting year {String(fact.data.period ?? data.year)}</p><p className="admin-footnote">Saved revision {fact.revision} · {String(fact.data.review_status).replaceAll('_', ' ')}</p>{reviewErrors[fact.id] && <Notice kind="error">{reviewErrors[fact.id]}<div><Button variant="ghost" onClick={async () => { try { const latest = await api.get<RecordItem>(`/facts/${fact.id}`); draft.setValue(previous => ({ ...previous, proposals: previous.proposals.map(item => item.id === latest.id ? latest : item) })); setChecked(previous => ({ ...previous, [fact.id]: false })); setReviewErrors(previous => ({ ...previous, [fact.id]: '' })); } catch (failure) { setReviewErrors(previous => ({ ...previous, [fact.id]: errorMessage(failure) })); } }}>Load this answer’s current saved version</Button></div></Notice>}{fact.data.review_status === 'proposed' && canReview && <><Field label="Where did you check this answer?"><input required value={draft.value.notes[fact.id] || ''} onChange={event => draft.setValue(previous => ({ ...previous, notes: { ...previous.notes, [fact.id]: event.target.value } }))} placeholder="For example, this year’s farm records"/></Field><label className="check-row"><input type="checkbox" checked={checked[fact.id] === true} onChange={event => setChecked(previous => ({ ...previous, [fact.id]: event.target.checked }))}/>I read this saved answer and checked that it is correct for this farm and year.</label><Button disabled={!checked[fact.id] || !draft.value.notes[fact.id]?.trim() || reviewing !== null} loading={reviewing === fact.id} onClick={() => void review(fact)}>Confirm this answer</Button></>}{fact.data.review_status === 'confirmed' && <Notice kind="success">This answer is confirmed. The checks below use the server’s latest saved evidence.</Notice>}</article>)}</div>}
    </>}
  </section>;
}

export function CompliancePage() {
  const { farms, farmId, year, choose } = useFarmChoice();
  const { session } = useSession();
  const [data, setData] = useState<Checks | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const attempt = useRef<string | null>(null);
  const [version, setVersion] = useState(0);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadedFarm = useRef('');
  const lastRequested = useRef(0);
  const canReview = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  useEffect(() => {
    let active = true;
    const identity = `${farmId}:${year}`;
    const sameFarm = loadedFarm.current === identity;
    setError('');
    if (!sameFarm) { setData(null); setMessage(''); setSelected([]); setCheckedAt(null); attempt.current = null; }
    setLoading(false); setRefreshing(false);
    if (!farmId) { loadedFarm.current = ''; return; }
    if (sameFarm) setRefreshing(true); else setLoading(true);
    lastRequested.current = Date.now();
    api.get<Checks>(`/compliance/farms/${encodeURIComponent(farmId)}?year=${encodeURIComponent(year)}`).then(value => { if (active) { setData(value); setCheckedAt(new Date().toISOString()); loadedFarm.current = identity; } }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) { setLoading(false); setRefreshing(false); } });
    return () => { active = false; };
  }, [farmId, year, version]);
  useEffect(() => {
    const refreshVisible = () => {
      if (farmId && !busy && document.visibilityState === 'visible' && Date.now() - lastRequested.current > 3000) {
        lastRequested.current = Date.now(); setVersion(value => value + 1);
      }
    };
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { window.removeEventListener('focus', refreshVisible); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [farmId, year, busy]);
  async function makeChecklist() {
    if (!data || !selected.length) return;
    setBusy(true); setError(''); setMessage('');
    attempt.current ??= crypto.randomUUID();
    try {
      const result = await api.post<{ checklists: RecordItem[]; tasks: RecordItem[]; skipped: unknown[] }>(`/compliance/farms/${data.farm_id}/checklist`, { rule_ids: selected, expected_farm_revision: data.farm_revision, year: data.year }, { idempotencyKey: attempt.current });
      setMessage(`${result.checklists.length} checklists and ${result.tasks.length} follow-up tasks saved.${result.skipped.length ? ` ${result.skipped.length} items were already present or skipped by the server.` : ''}`);
      setSelected([]); attempt.current = null;
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  const applicability = { applies: 'Applies to recorded farm details', does_not_apply: 'Does not apply to recorded farm details', unknown: 'More farm details needed', conflict: 'Farm details disagree' };
  return <>
    <PageHeader title="What still needs checking?" description="Start with your farm details, then work through the information and evidence each check needs." action={<Link className="button button-secondary" to="/app/updates">Official source updates</Link>}/>
    <section className="panel admin-section"><div className="form-grid"><Field label="Which farm?"><select value={farmId} onChange={event => choose(event.target.value)}><option value="">Choose a farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field><Field label="Reporting year"><input type="number" min="2000" max="2100" value={year} onChange={event => choose(farmId, event.target.value)}/></Field></div>{farms.error && <Notice kind="error">{farms.error}</Notice>}{farms.loading && <Loading>Opening farms…</Loading>}{!farms.loading && !farms.items.length && <p><Link to="/app/fields">Add your farm</Link> to see which information may be relevant.</p>}{!farmId && farms.items.length > 0 && <p className="admin-footnote">Choose the farm you want to work on. Each farm keeps its own checks and evidence.</p>}</section>
    {error && <Notice kind="error">{error}<div><Button variant="ghost" onClick={() => setVersion(value => value + 1)}>Check again</Button></div></Notice>}{message && <Notice kind="success">{message} <Link to="/app/guidance">Open saved checklists</Link></Notice>}{loading && <Loading>Comparing your recorded details with the available checks…</Loading>}
    {data && <>
      <p className="admin-footnote" role="status">{refreshing ? 'Refreshing farm checks…' : checkedAt ? `Checked ${new Date(checkedAt).toLocaleString()}. Checks refresh when you return to this tab.` : 'No completed check is recorded.'}</p>
      <Notice kind={data.overall === 'ready_for_review' ? 'info' : 'warning'}>{data.overall === 'ready_for_review' ? 'The available checks are ready for your review.' : data.overall === 'needs_adviser' ? 'Some questions need an adviser or further source checks.' : 'Some farm details or supporting records are still needed.'} This is a preparation aid, not an authority decision or a confirmation of legal compliance.</Notice>
      <ProfileAnswers key={`${data.farm_id}:${data.year}`} data={data} canReview={canReview} onSaved={() => setVersion(value => value + 1)}/>
      {data.issues.length > 0 && <section className="panel admin-section"><h2>Things to sort out first</h2><ul className="admin-task-list">{data.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><p>{issue.message}</p>{localHref(issue.href) && <Link to={localHref(issue.href)!}>Open the related record</Link>}</li>)}</ul></section>}
      <section className="panel admin-section"><div className="section-heading"><h2>Work through the checks</h2><Button variant="secondary" onClick={() => setVersion(value => value + 1)} disabled={busy}>Refresh checks</Button></div>{!data.obligations.length && <p className="empty-state">No obligations have been identified from the available rules and recorded details. This does not establish that the farm has no obligations. Check the official source or ask your adviser.</p>}
        {data.obligations.map(obligation => <article className="admin-check" key={obligation.id}><div className="section-heading"><h3>{obligation.title}</h3><span className="badge">{applicability[obligation.applicability]}</span></div><p className="muted">{obligation.progress.with_evidence} of {obligation.progress.required} required items have evidence · {obligation.progress.needs_review} need review</p><p><strong>Deadline:</strong> {obligation.deadline.date ?? 'No established date'}{obligation.deadline.message ? ` · ${obligation.deadline.message}` : ''}</p>
          <Steps items={obligation.steps}/><details><summary>Required information and its sources</summary><ul className="admin-task-list">{obligation.requirements.map(requirement => <li key={requirement.id}><strong>{requirement.label}</strong><span className="badge">{requirement.status.replaceAll('_', ' ')}</span>{requirement.issues?.map((issue, index) => <p key={index}>{typeof issue === 'string' ? issue : issue.message}</p>)}<Steps items={requirement.steps ?? []}/></li>)}</ul><Sources items={obligation.citations}/>{obligation.limits.length > 0 && <ul className="admin-footnote">{obligation.limits.map((limit, index) => <li key={index}>{limit}</li>)}</ul>}</details>
          {canReview && obligation.applicability !== 'does_not_apply' && <label className="check-row"><input type="checkbox" checked={selected.includes(obligation.id)} disabled={busy} onChange={event => { setSelected(previous => event.target.checked ? [...previous, obligation.id] : previous.filter(id => id !== obligation.id)); attempt.current = null; }}/>Make a checklist and follow-up tasks for this check</label>}
        </article>)}
        {canReview && data.obligations.length > 0 && <div className="admin-subsection"><Button loading={busy} disabled={!selected.length} onClick={() => void makeChecklist()}>Save selected checklists and tasks</Button><p className="admin-footnote">This saves a to-do list. It does not confirm evidence, approve a report or send anything to an authority.</p></div>}
      </section>
      <section className="admin-footnote"><p>Rules edition {data.rules_version} · updated {data.rules_updated_at ? new Date(data.rules_updated_at).toLocaleDateString() : 'date not supplied'}</p>{data.limits.length > 0 && <ul>{data.limits.map((limit, index) => <li key={index}>{limit}</li>)}</ul>}<Link to="/app/community">Ask your adviser about an unclear check</Link></section>
    </>}
  </>;
}

export function UpdatesPage() {
  const { farms, farmId, choose } = useFarmChoice();
  const [data, setData] = useState<Updates | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const reload = useCallback(async () => {
    if (farmId) setData(await api.get<Updates>(`/regulatory/updates?farm_id=${encodeURIComponent(farmId)}`));
  }, [farmId]);
  useEffect(() => {
    let active = true; setData(null); setError(''); setMessage(''); setLoading(false);
    if (!farmId) return;
    setLoading(true);
    api.get<Updates>(`/regulatory/updates?farm_id=${encodeURIComponent(farmId)}`).then(value => { if (active) setData(value); }).catch(failure => { if (active) setError(errorMessage(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [farmId, version]);
  async function preference(enabled: boolean, readIds: string[]) {
    if (!data) return;
    setBusy(true); setError(''); setMessage('');
    try { await api.post('/regulatory/preferences', { farm_id: farmId, expected_revision: data.preferences.revision, enabled, families: data.preferences.families, read_event_ids: readIds }); await reload(); setMessage('Your in-app update preference is saved.'); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <>
    <PageHeader title="Changes to official source pages" description="See recorded changes to relevant official pages, then check what they mean for your farm." action={<Link className="button button-secondary" to={`/app/checks${farmId ? `?farm_id=${farmId}` : ''}`}>Back to farm checks</Link>}/>
    <section className="panel admin-section"><Field label="Which farm?"><select value={farmId} onChange={event => choose(event.target.value)}><option value="">Choose a farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field>{farms.error && <Notice kind="error">{farms.error}</Notice>}{farms.loading && <Loading>Opening farms…</Loading>}{!farmId && !farms.loading && <p className="admin-footnote">Choose a farm to see the relevant recorded source changes.</p>}</section>
    {error && <Notice kind="error">{error}<div><Button variant="ghost" onClick={() => setVersion(value => value + 1)}>Try again</Button></div></Notice>}{message && <Notice kind="success">{message}</Notice>}{loading && <Loading>Opening recorded source updates…</Loading>}
    {data && <>
      <Notice>{data.notice} A changed web page does not by itself establish a changed legal duty or an effective date.</Notice>
      <section className="panel admin-section"><h2>What has actually been observed?</h2><p>{data.monitor.baseline_count === undefined ? 'The server has not supplied a successful baseline count.' : `${data.monitor.baseline_count} of ${data.monitor.source_count} sources have a successful observation baseline.`}</p>{data.monitor.meaning && <p className="admin-footnote">{data.monitor.meaning}</p>}{!!data.source_checks?.length && <details><summary>Which source pages have been checked?</summary><ul className="admin-task-list">{data.source_checks.map(source => <li key={source.source_id}><strong>{source.title}</strong><p>{source.status.replaceAll('_', ' ')} · {source.baseline_exists ? 'Observation baseline exists' : 'No successful baseline yet'}</p>{sourceUrl(source.url) && <a href={sourceUrl(source.url)!} target="_blank" rel="noreferrer">Open source page</a>}</li>)}</ul></details>}</section>
      <section className="panel admin-section"><h2>How you want to see updates</h2><label className="check-row"><input type="checkbox" checked={data.preferences.enabled} disabled={busy} onChange={event => void preference(event.target.checked, data.preferences.read_event_ids)}/>Show relevant source changes inside my farm workspace</label><p className="admin-footnote">This preference does not turn on email, push messages or background collection of your farm data.</p><p className="muted">Source checking is {data.monitor.enabled ? 'enabled' : 'not enabled on this server'}.{data.monitor.last_checked_at ? ` Last check: ${new Date(data.monitor.last_checked_at).toLocaleString()}.` : ' No completed source check is recorded.'} {data.monitor.error_count > 0 ? `${data.monitor.error_count} sources could not be checked.` : ''}</p><Button variant="secondary" disabled={busy} onClick={() => setVersion(value => value + 1)}>Refresh recorded updates</Button></section>
      <section className="panel admin-section"><h2>{data.unread_count} unread source changes</h2>{!data.items.length && <p className="empty-state">No relevant source changes are recorded for this farm. This is not a guarantee that regulations have not changed.</p>}{data.items.map(update => <article className="admin-check" key={update.id}><div className="section-heading"><h3>{update.title}</h3><span className="badge">{update.is_read ? 'Marked as read' : 'New to you'}</span></div><p>{update.notice}</p>{update.required_action && <p>{update.required_action}</p>}<p className="admin-footnote">Page change detected {new Date(update.detected_at).toLocaleString()}{update.source_edition ? ` · source edition ${update.source_edition}` : ''}. Effective date has not been established by this observation.</p>{sourceUrl(update.url) && <p><a href={sourceUrl(update.url)!} target="_blank" rel="noreferrer">Read the official page</a></p>}<div className="actions"><Link to={`/app/checks?farm_id=${farmId}`}>Check recorded farm requirements</Link>{!update.is_read && <Button variant="secondary" loading={busy} onClick={() => void preference(data.preferences.enabled, [...new Set([...data.preferences.read_event_ids, update.id])])}>Mark as read</Button>}</div></article>)}</section>
    </>}
  </>;
}
