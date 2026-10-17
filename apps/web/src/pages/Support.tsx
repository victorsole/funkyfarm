import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { useSession } from '../auth';
import type { Pack, Page, RecordItem } from '../types';
import { countries, useReviewAccess } from './Core';
import { FarmChecklists } from './Checklists';
import './guidance.css';

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const topics: Record<string, string> = { annual: 'Annual records', cap: 'CAP and parcels', inputs: 'Inputs and treatments', inspection: 'Inspection responses', sustainability: 'Environmental records' };
const checkLabels: Record<string, string> = {
  actual_application_date_and_year: 'Check each application’s actual date and campaign year.',
  conditional_original_location_identifiers: 'Keep the original location references needed for this application.',
  confirmed_source_revision: 'Check the reviewed version of each source record.',
  distinct_confirmed_active_applications: 'Select separately confirmed, current applications without duplicates.',
  explicit_confirmed_holder_identity: 'Review and confirm the holder’s identity separately.',
  explicit_ordered_dated_selection: 'Choose the dated records explicitly and keep their order.',
  explicit_pending_follow_up: 'Leave follow-up results pending when they are not yet known.',
  immutable_source_bound_journal_snapshot: 'Keep the reviewed journal and its exact source versions together.',
  literal_schema: 'Preserve the source’s original fields and values.',
  reviewed_identity: 'Check the holder’s reviewed identity details.',
  source_decimal_precision_and_original_units: 'Keep the source’s decimal precision and original units.',
  source_document_revision: 'Use the exact selected version of the source document.',
  unresolved_content_acknowledgement: 'Read and acknowledge unresolved content before continuing.',
};
const words = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const humanize = (value: string) => {
  const sentence = value.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};
type GuideField = { key?: string; label?: string; description?: string; required?: boolean | string; unit?: string | null; temporal_basis?: string; row_columns?: { label?: string; unit?: string | null }[] };
type GuideSource = { url?: string; title?: string; edition?: string };
type Guide = { pack_id: string; version?: string; capability?: string; effective_date?: string; fields?: GuideField[]; sources?: GuideSource[]; checks?: unknown[]; limits?: unknown };
function ErrorNotice({ error }: { error: unknown }) {
  return error ? <Notice kind="error">{errorMessage(error)}{error instanceof ApiError && error.status === 409 && <p>Your entries are still here. Reload the latest record and compare before trying again.</p>}</Notice> : null;
}
function titleOf(pack: Pack) {
  const country = pack.country ? countryNames.of(pack.country) : '';
  let title = words(pack.title) || words(pack.name) || topics[pack.workflow_id] || 'Farm records';
  if (country && title.startsWith(country + ':')) title = title.slice(country.length + 1).trim();
  return title.replace(/\s*[—–-]\s*mapping unavailable$/i, '');
}
function availability(pack: Pack) {
  const fields: GuideField[] = Array.isArray(pack.fields) ? pack.fields : [];
  const canPrepare = ['generic_dossier', 'manual_preparation', 'sourced_draft_mapping'].includes(pack.capability) && fields.length > 0;
  const checklist = canPrepare && fields.some(field => !!field.required);
  return {
    canPrepare, checklist,
    label: !canPrepare ? (Array.isArray(pack.sources) && pack.sources.length ? 'Source guide' : 'Not yet available') : checklist ? 'Checklist and draft' : 'Draft preparation',
    description: !canPrepare ? 'Country-specific preparation is not available here. Read any listed sources and check the official route.'
      : pack.capability === 'generic_dossier' ? 'Organise reviewed farm evidence into a summary, not a national filing form.'
      : 'Gather the listed information and prepare a draft for review. Check the source edition and the limits below.',
  };
}
function safeSource(url?: string) {
  if (!url) return null;
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null; }
  catch { return null; }
}
function readable(value: unknown): string {
  if (typeof value === 'string') return checkLabels[value] || humanize(value);
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  return words(item.message) || words(item.description) || words(item.label) || (words(item.code) ? humanize(words(item.code)) : '');
}
function FarmSelect({ farms }: { farms: RecordItem[] }) {
  return <select name="farm_id" required defaultValue=""><option value="">Choose a farm</option>{farms.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select>;
}

export function GuidancePage() {
  const { session } = useSession();
  const [params] = useSearchParams();
  const notifications = useRecords('guidance/notifications');
  const [country, setCountry] = useState(params.get('country') || '');
  const [year, setYear] = useState(params.get('year') ?? String(new Date().getFullYear()));
  const [topic, setTopic] = useState(params.get('topic') || '');
  const [search, setSearch] = useState(params.get('q') || '');
  const [result, setResult] = useState<{ binding: string; items: Pack[]; loading: boolean; error: unknown }>({ binding: '', items: [], loading: true, error: null });
  const [retry, setRetry] = useState(0);
  const validYear = /^\d{4}$/.test(year) && Number(year) >= 1900 && Number(year) <= 2200;
  const binding = (session?.workspace.id ?? '') + '/' + country + '/' + year + '/' + retry;
  useEffect(() => {
    let active = true;
    setResult({ binding, items: [], loading: validYear, error: null });
    if (validYear) api.get<Page<Pack>>('/packs?' + new URLSearchParams({ year, ...(country && country !== 'general' ? { country } : {}) }))
      .then(page => { if (active) setResult({ binding, items: page.items, loading: false, error: null }); })
      .catch(error => { if (active) setResult({ binding, items: [], loading: false, error }); });
    return () => { active = false; };
  }, [binding, validYear]);
  const current = result.binding === binding ? result : { items: [], loading: validYear, error: null };
  const needle = search.trim().toLocaleLowerCase();
  const matching = current.items.filter(pack => (!topic || pack.workflow_id === topic) && (country !== 'general' || !pack.country)
    && (!needle || (titleOf(pack) + ' ' + (pack.country ? countryNames.of(pack.country) : 'General farm records') + ' ' + (topics[pack.workflow_id] ?? '')).toLocaleLowerCase().includes(needle)));
  const groups = [...new Set(matching.map(pack => pack.country || 'general'))].sort((a, b) => {
    if (a === 'general') return -1;
    if (b === 'general') return 1;
    return (countryNames.of(a) ?? a).localeCompare(countryNames.of(b) ?? b);
  });
  const countryOverview = !country && !needle;
  const actionable = matching.filter(pack => availability(pack).canPrepare);
  const otherTopics = matching.filter(pack => !availability(pack).canPrepare);
  const actionableGroups = groups.filter(code => actionable.some(pack => (pack.country || 'general') === code));
  const returnQuery = new URLSearchParams({ country, year, topic, q: search }).toString();
  return <div className="guidance-page">
    <PageHeader title="Guidance for your farm" description="Choose a country and the job you need to do." />
    <section className="card guidance-filters" aria-label="Find guidance"><div className="form-grid">
      <Field label="Country"><select value={country} onChange={event => setCountry(event.target.value)}><option value="">Choose a country</option><option value="general">General farm records</option>{countries.map(code => <option key={code} value={code}>{countryNames.of(code)}</option>)}</select></Field>
      <Field label="Topic"><select value={topic} onChange={event => setTopic(event.target.value)}><option value="">All topics</option>{Object.entries(topics).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      <Field label="Reporting year"><input type="number" min="1900" max="2200" value={year} onChange={event => setYear(event.target.value)} /></Field>
      <Field label="Find guidance"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Country, records or task" /></Field>
    </div></section>
    {!validYear && <p>Enter a reporting year from 1900 to 2200.</p>}
    {!!current.error && <Notice kind="error">{errorMessage(current.error)}<div><Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Reload guidance</Button></div></Notice>}
    {current.loading && <p role="status">Finding guidance…</p>}
    {!current.loading && validYear && !current.error && !matching.length && <p>No guidance is available for these choices. Try another topic or year.</p>}
    {!current.loading && countryOverview && <div className="guidance-country-grid">{groups.map(code => {
      const items = matching.filter(pack => (pack.country || 'general') === code);
      const available = items.filter(pack => availability(pack).canPrepare).length;
      const name = code === 'general' ? 'General farm records' : countryNames.of(code) ?? code;
      return <section className="card guidance-country" key={code}><h2>{name}</h2><p>{available} {available === 1 ? 'guide' : 'guides'} with draft preparation</p><Button variant="secondary" onClick={() => setCountry(code)}>View {name} guidance</Button></section>;
    })}</div>}
    {!current.loading && !countryOverview && actionableGroups.map(code => <section className="guidance-country-section" key={code}>
      <h2>{code === 'general' ? 'General farm records' : countryNames.of(code)}</h2><div className="guidance-topic-grid">{actionable.filter(pack => (pack.country || 'general') === code).map(pack => {
        const support = availability(pack);
        return <article className="card guidance-topic" key={pack.id}><p className="guidance-topic-label">{topics[pack.workflow_id] ?? 'Farm records'}</p><h3>{titleOf(pack)}</h3><span className="guidance-status guidance-status-ready">{support.label}</span><Link className="button button-secondary" aria-label={'Read guidance: ' + titleOf(pack)} to={'/app/guidance/' + encodeURIComponent(pack.id) + '?' + returnQuery}>Read guidance</Link></article>;
      })}</div>
    </section>)}
    {!current.loading && !countryOverview && !!otherTopics.length && <section className="card guidance-other-topics"><h2>Other topics</h2><p>These topics do not have draft preparation here. Open a topic for any available source information and its limits.</p><ul>{otherTopics.map(pack => <li key={pack.id}><Link aria-label={'Read guidance: ' + titleOf(pack)} to={'/app/guidance/' + encodeURIComponent(pack.id) + '?' + returnQuery}>{titleOf(pack)}</Link><span className="muted">{pack.country ? countryNames.of(pack.country) : 'General farm records'}</span></li>)}</ul></section>}
    <FarmChecklists />
    {!!notifications.items.length && <section className="card"><h2>Reviewed changes</h2>{notifications.items.map(item => <article className="guidance-change" key={item.id}><h3>{words(item.data.title) || 'Source change'}</h3>{words(item.data.explanation || item.data.message) && <p>{words(item.data.explanation || item.data.message)}</p>}{words(item.data.required_action) && <p>{words(item.data.required_action)}</p>}{words(item.data.effective_date) && <p className="muted">Effective {words(item.data.effective_date)}</p>}</article>)}</section>}
    {notifications.error && <Notice kind="error">{notifications.error}</Notice>}
  </div>;
}

export function GuidanceDetailPage() {
  const { packId = '' } = useParams<{ packId: string }>();
  const [params] = useSearchParams();
  const { session } = useSession();
  const canReview = useReviewAccess();
  const farms = useRecords('farms');
  const [result, setResult] = useState<{ binding: string; pack: Pack | null; guide: Guide | null; error: unknown; loading: boolean }>({ binding: '', pack: null, guide: null, error: null, loading: true });
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<RecordItem | null>(null);
  const [checklistVersion, setChecklistVersion] = useState(0);
  const sending = useRef(false);
  const binding = (session?.workspace.id ?? '') + '/' + packId + '/' + retry;
  const currentBinding = useRef(binding);
  currentBinding.current = binding;
  useEffect(() => {
    let active = true;
    setError(null); setCreated(null);
    setResult({ binding, pack: null, guide: null, error: null, loading: true });
    if (!packId) { setResult({ binding, pack: null, guide: null, error: new Error('Choose a guide from the country list.'), loading: false }); return; }
    Promise.all([api.get<Pack>('/packs/' + encodeURIComponent(packId)), api.get<Guide>('/guidance?pack_id=' + encodeURIComponent(packId))])
      .then(([pack, guide]) => { if (active) setResult({ binding, pack, guide, error: null, loading: false }); })
      .catch(cause => { if (active) setResult({ binding, pack: null, guide: null, error: cause, loading: false }); });
    return () => { active = false; };
  }, [binding, packId]);
  const current = result.binding === binding ? result : { pack: null, guide: null, error: null, loading: true };
  const pack = current.pack;
  const guide = current.guide;
  const spanishParcelGuide = pack?.id === 'ES-cap-2026';
  const fields = Array.isArray(guide?.fields) ? guide.fields : [];
  const sources = (Array.isArray(guide?.sources) ? guide.sources : []).filter(source => safeSource(source.url));
  const limits = spanishParcelGuide
    ? ['Regional rules and deadlines still need checking with your paying agency.', 'Map edits here do not update SIGPAC or send an application.']
    : (Array.isArray(guide?.limits) ? guide.limits : [guide?.limits]).map(readable).filter(Boolean);
  const checks = (Array.isArray(guide?.checks) ? guide.checks : []).map(readable).filter(Boolean);
  const support = pack ? availability({ ...pack, fields }) : null;
  const eligibleFarms = pack ? farms.items.filter(farm => (!pack.country || farm.data.country === pack.country) && (!pack.region || farm.data.region === pack.region)) : [];
  async function createChecklist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !pack || !support?.checklist) return;
    const form = new FormData(event.currentTarget);
    const farmId = String(form.get('farm_id') || '');
    if (!eligibleFarms.some(farm => farm.id === farmId)) { setError(new Error('Choose an available farm for this country and region.')); return; }
    const context = binding;
    sending.current = true; setBusy(true); setError(null); setCreated(null);
    try {
      const record = await api.post<RecordItem>('/checklists/from-pack', { farm_id: farmId, pack_id: pack.id, ...(form.get('deadline') ? { deadline: form.get('deadline') } : {}) });
      if (context === currentBinding.current) { setCreated(record); setChecklistVersion(value => value + 1); }
    } catch (cause) {
      if (context === currentBinding.current) { setError(cause); setChecklistVersion(value => value + 1); }
    } finally { sending.current = false; setBusy(false); }
  }
  return <div className="guidance-page">
    <Link className="guidance-back" to={'/app/guidance' + (params.toString() ? '?' + params.toString() : '')}>All guidance</Link>
    {current.loading && <p role="status">Opening guidance…</p>}
    {!!current.error && <Notice kind="error">{errorMessage(current.error)}<div><Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Reload guidance</Button></div></Notice>}
    {pack && guide && support && <>
      <PageHeader title={titleOf(pack)} description={(pack.country ? countryNames.of(pack.country) : 'General farm records') + (pack.region ? ' · ' + pack.region : '') + (pack.reporting_year ? ' · ' + pack.reporting_year : '')} />
      <section className="card guidance-summary"><span className={'guidance-status ' + (support.canPrepare ? 'guidance-status-ready' : '')}>{spanishParcelGuide ? 'Field checks available' : support.label}</span><p>{spanishParcelGuide ? 'Compare parcel outlines, check supporting records and prepare a correction. The full Spanish CAP application form is not available here.' : support.description}</p><p className="muted">No agency connection or automatic filing is provided by this guide.</p>{guide.version && <p className="guidance-edition">Edition {guide.version}{guide.effective_date ? ' · Effective ' + guide.effective_date : ''}</p>}</section>
      {spanishParcelGuide && <section className="card"><h2>Check a Spanish field</h2><p>Start with the map, then review the answers and any missing documents.</p><div className="actions"><Link className="button button-primary" to="/app/demo?step=fields">Try the Spanish parcel demo</Link><Link className="button button-secondary" to="/app/fields">Choose my farm</Link></div>{eligibleFarms.map(farm => <p key={farm.id}><Link to={`/app/fields/${encodeURIComponent(farm.id)}/check`}>Check {farm.data.name}</Link></p>)}<p><a href="https://www.juntaex.es/w/5698" target="_blank" rel="noreferrer">Extremadura: official SIGPAC correction instructions</a></p></section>}
      {!!fields.length && <section className="card"><h2>Information to gather</h2><ul className="guidance-answer-list">{fields.map((field, index) => <li key={field.key || index}><div><strong>{words(field.label) || 'Recorded answer'}</strong>{field.required && <span className="guidance-required">{field.required === 'conditional' ? 'When applicable' : 'Needed for this draft'}</span>}</div>{words(field.description) && <p>{words(field.description)}</p>}{(field.unit || field.temporal_basis) && <p className="muted">{[field.unit, field.temporal_basis === 'campaign_year' ? 'Campaign year' : field.temporal_basis === 'calendar_date' ? 'Actual date' : field.temporal_basis === 'static' ? 'Standing farm detail' : ''].filter(Boolean).join(' · ')}</p>}{!!field.row_columns?.length && <p className="muted">Each row includes: {field.row_columns.map(column => words(column.label)).filter(Boolean).join(', ')}.</p>}</li>)}</ul></section>}
      {!!checks.length && <section className="card"><h2>Checks before you finish</h2><ul className="guidance-plain-list">{checks.map((check, index) => <li key={index}>{check}</li>)}</ul></section>}
      {!!sources.length && <section className="card"><h2>Source documents</h2><ul className="guidance-source-list">{sources.map((source, index) => <li key={index}><a href={safeSource(source.url)!} target="_blank" rel="noreferrer">{words(source.title) || 'Open source document'}</a>{words(source.edition) && <p className="muted">{source.edition}</p>}</li>)}</ul></section>}
      {!!limits.length && <section className="card"><h2>Before you rely on this</h2><ul className="guidance-plain-list">{limits.map((limit, index) => <li key={index}>{limit}</li>)}</ul></section>}
      {!support.canPrepare && typeof pack.common_pack_id === 'string' && pack.common_pack_id !== pack.id && <p><Link className="button button-secondary" to={'/app/guidance/' + encodeURIComponent(pack.common_pack_id)}>Organise a general evidence summary</Link></p>}
      {support.checklist && <section className="card"><h2>Prepare an evidence checklist</h2>{!canReview ? <p>Your access is read-only. A farm owner or reviewer can create this checklist.</p> : farms.loading ? <p role="status">Finding your farms…</p> : farms.error ? <Notice kind="error">{farms.error}</Notice> : !eligibleFarms.length ? <p>No available farm matches this guide’s country and region.</p> : <form className="stack" onSubmit={createChecklist}><fieldset className="guidance-form-fields" disabled={busy}><div className="form-grid"><Field label="Farm"><FarmSelect farms={eligibleFarms} /></Field><Field label="Deadline (optional)"><input name="deadline" type="date" /></Field></div><Button type="submit" loading={busy}>Create checklist for this farm</Button></fieldset></form>}<ErrorNotice error={error} />{error instanceof ApiError && error.status === 0 && <p>Check your saved checklists before trying again; the request may have completed.</p>}{created && <Notice kind="success">Checklist created. <Link to={'/app/guidance?checklist_id=' + encodeURIComponent(created.id)}>Open your checklist</Link></Notice>}</section>}
      {support.canPrepare && <FarmChecklists key={binding + '/' + checklistVersion} />}
    </>}
  </div>;
}

export function SettingsPage() {
  const {session,logout} = useSession(); const [settings,setSettings] = useState<RecordItem | null>(null); const [error,setError] = useState<unknown>(null); const [busy,setBusy] = useState(false); const [saved,setSaved] = useState(false);
  async function load(){setError(null);try{setSettings(await api.get('/account'));}catch(e){setError(e);}}
  useEffect(()=>{void load();},[]);
  return <><PageHeader title="Settings" description="Choose defaults for new records. Existing farm details stay unchanged."/><ErrorNotice error={error}/>{saved && <Notice kind="success">Your preferences are saved.</Notice>}{settings ? <section className="card"><form key={settings.revision} className="stack" onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);setBusy(true);setError(null);setSaved(false);try{setSettings(await api.patch('/account',{expected_revision:settings.revision,data:{language:settings.data.language,country:f.get('country')||null,region:f.get('region')||null,reporting_year:Number(f.get('reporting_year')),notifications:f.get('notifications')==='on'}}));setSaved(true);}catch(e){setError(e);}finally{setBusy(false);}}}><div className="form-grid"><Field label="Default country"><select name="country" defaultValue={settings.data.country||''}><option value="">Choose when adding a farm</option>{countries.map(c=><option key={c} value={c}>{countryNames.of(c)}</option>)}</select></Field><Field label="Default region"><input name="region" defaultValue={settings.data.region||''}/></Field><Field label="Default reporting year"><input name="reporting_year" type="number" min="1900" max="2200" defaultValue={settings.data.reporting_year||new Date().getFullYear()} required/></Field></div><label><input name="notifications" type="checkbox" defaultChecked={settings.data.notifications===true}/> Show workspace notifications</label><p className="muted">Notifications are shown inside the workspace. Saving this preference does not enable email or device reminders.</p><div className="actions"><Button type="submit" loading={busy}>Save preferences</Button>{error instanceof ApiError && error.status===409 && <Button variant="secondary" onClick={()=>void load()}>Load latest preferences</Button>}</div></form></section>:!error&&<Notice>Opening preferences…</Notice>}<section className="card"><h2>Your account</h2><p>{session?.user.display_name} · {session?.user.email}</p><p>{session?.workspace.name} · {session?.workspace.role}</p><Button variant="secondary" loading={busy} onClick={async()=>{setBusy(true);try{await logout();}catch(e){setError(e);}finally{setBusy(false);}}}>Sign out</Button></section></>;
}
