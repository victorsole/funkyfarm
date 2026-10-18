// The Farmer and Adviser dashboards: overview tiles and findings, the map page, and the messages
// between a farmer and their adviser. Advisers include civil servants at farmer-help offices; every
// adviser sees only the farms whose farmer granted access, and the server enforces that.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader, WhoDecides } from '../components';
import { Findings, StatTiles, type Finding } from '../dashboard';
import { useRecords } from '../hooks';
import { SigpacMap, type MapField } from '../maps/SigpacMap';
import type { FieldStatus } from '../maps/landUse';
import type { RecordItem } from '../types';
import type { FieldGeometry } from './FieldsMap';
import { VoiceButton } from '../voice';

type Parcel = { id: string; name: string; crop?: string | null; geometry?: FieldGeometry | null; external_id?: string | null; approximate_area_ha?: number | null };
type Issue = { id: string; field_id: string | null; field_name: string; severity: 'error' | 'warning'; title: string; explanation: string; who_decides?: string; action_href?: string };
type ParcelCheck = { issue_total: number; issues: Issue[]; check_href?: string };
type Question = { title: string; body: string; status: 'open' | 'answered' | 'closed'; farm_id: string; recipient_id: string; asked_by: string; responses: { author_id: string; body: string; at: string }[] };
type Page<T> = { items: T[]; total: number };
type Workspace = { id: string; name: string; role: string };

const sampleName = (value: unknown) => String(value ?? '').replace(/^\s*FICTIONAL(?:[\s:_-]+|$)/i, '') || 'Farm';
const levelOf = (issues: Issue[]): FieldStatus => issues.some(issue => issue.severity === 'error') ? 'conflict' : issues.length ? 'gap' : 'ok';
const statusText: Record<FieldStatus, string> = { conflict: 'needs action', gap: 'missing information', ok: 'no open findings' };
const countryName = (code: unknown) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(String(code)) ?? String(code); } catch { return 'this country'; } };
const hectares = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ha`;

function parcelCheckPath(farm: RecordItem) {
  return `/farms/${farm.id}/parcel-check?${new URLSearchParams({ expected_farm_revision: String(farm.revision), reporting_year: String(farm.data.reporting_year ?? new Date().getFullYear()), limit: '100' })}`;
}
function issueFindings(farm: RecordItem, issues: Issue[], hrefFor: (issue: Issue) => string): Finding[] {
  return issues.map(issue => ({
    id: `${farm.id}:${issue.id}`, level: issue.severity === 'error' ? 'conflict' : 'gap', title: `${issue.field_name}: ${issue.title}`,
    detail: issue.explanation, href: hrefFor(issue), action: 'Check',
    who: /paying agency/i.test(issue.who_decides ?? '') ? <WhoDecides who="agency">Paying agency decides</WhoDecides> : undefined,
  }));
}
function fieldsOnMap(farm: RecordItem, parcels: Parcel[], issues: Issue[], href: string): MapField[] {
  return parcels.filter(parcel => parcel.geometry).map(parcel => {
    const own = issues.filter(issue => issue.field_id === parcel.id);
    const status = levelOf(own);
    return { id: `${farm.id}:${parcel.id}`, group: farm.id, reference: parcel.external_id ?? null, label: `${sampleName(farm.data.name)} · ${parcel.name}`, geometry: parcel.geometry!, status, href,
      detail: [parcel.crop, statusText[status]].filter(Boolean).join(' · ') };
  });
}

/* ---------- Farmer ---------- */

export function FarmerOverview({ farm, deadlines, missing }: { farm: RecordItem; deadlines: number; missing: { code: string; label: string; message: string; href?: string }[] }) {
  const { session } = useSession();
  const [fields, setFields] = useState<Parcel[] | null>(null);
  // undefined while loading, null when the check could not run.
  const [check, setCheck] = useState<ParcelCheck | null | undefined>(undefined);
  const [questions, setQuestions] = useState<Page<RecordItem<Question>> | null>(null);
  useEffect(() => {
    let active = true;
    api.get<{ items: Parcel[] }>(`/farms/${farm.id}/fields`).then(result => { if (active) setFields(result.items); }).catch(() => { if (active) setFields([]); });
    api.get<ParcelCheck>(parcelCheckPath(farm)).then(result => { if (active) setCheck(result); }).catch(() => { if (active) setCheck(null); });
    if (session?.workspace.role === 'owner') api.get<Page<RecordItem<Question>>>(`/adviser/questions?farm_id=${farm.id}&limit=50`).then(result => { if (active) setQuestions(result); }).catch(() => undefined);
    return () => { active = false; };
  }, [farm.id, farm.revision]);
  const area = (fields ?? []).reduce((sum, field) => sum + (field.approximate_area_ha ?? 0), 0);
  const checkHref = `/app/fields/${farm.id}/check`;
  const open = questions?.items.filter(item => item.data.status !== 'closed') ?? [];
  const answered = open.filter(item => item.data.status === 'answered').length;
  const findings: Finding[] = [
    ...issueFindings(farm, check?.issues ?? [], () => checkHref),
    ...missing.map((item, index) => ({ id: `missing:${item.code}:${index}`, level: 'gap' as const, title: item.label, detail: item.message, href: item.href ?? '/app/home', action: 'Add' })),
  ];
  return <section className="dash-section" aria-label="Farm overview">
    <StatTiles label="Farm figures" items={[
      { label: 'Fields', value: fields ? fields.length : '…', detail: fields ? `about ${hectares(area)} from the outlines` : 'Loading', href: `/app/map?farm_id=${farm.id}`, tone: 'farm' },
      { label: 'Things to check', value: check ? check.issue_total : check === null ? '?' : '…', detail: check ? (check.issue_total ? 'before you send anything' : 'nothing open') : check === null ? 'Open the field check' : 'Checking your fields', href: checkHref, tone: check?.issue_total ? 'alert' : 'ok' },
      { label: 'Dates', value: deadlines, detail: 'deadlines and dated tasks', href: '/app/tasks', tone: 'gov' },
      { label: 'My adviser', value: questions ? open.length : '…', detail: answered ? `${answered} answered` : 'open questions', href: `/app/my-adviser?farm_id=${farm.id}`, tone: 'help' },
    ]}/>
    <h2>Findings <small className="muted">{findings.length ? `${findings.length} to look at` : ''}</small></h2>
    <Findings loading={check === undefined} items={findings.slice(0, 8)} empty={check === undefined ? 'Checking your fields…' : check === null ? 'The field check could not run here. Open it from the tile above.' : 'No open findings on your fields.'}/>
    {findings.length > 8 && <p><Link to={checkHref}>See all {findings.length} findings</Link></p>}
  </section>;
}

function useFarmChoice() {
  const farms = useRecords('farms');
  const [params] = useSearchParams();
  const [farmId, setFarmId] = useState(params.get('farm_id') ?? '');
  const chosen = farms.items.find(farm => farm.id === farmId) ?? (farms.items.length === 1 ? farms.items[0] : farms.items[0]);
  return { farms, chosen, setFarmId };
}

export function FarmerMapPage() {
  const navigate = useNavigate();
  const { farms, chosen, setFarmId } = useFarmChoice();
  const [parcels, setParcels] = useState<Parcel[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!chosen) return;
    let active = true;
    setError('');
    api.get<{ items: Parcel[] }>(`/farms/${chosen.id}/fields`).then(result => { if (active) setParcels(result.items); }).catch(failure => { if (active) setError(errorMessage(failure)); });
    api.get<ParcelCheck>(parcelCheckPath(chosen)).then(result => { if (active) setIssues(result.issues); }).catch(() => { if (active) setIssues([]); });
    return () => { active = false; };
  }, [chosen?.id, chosen?.revision]);
  const href = chosen ? `/app/fields/${chosen.id}/check` : '/app/fields';
  const mapFields = useMemo(() => chosen ? fieldsOnMap(chosen, parcels, issues, href) : [], [chosen?.id, parcels, issues]);
  const covered = ['ES', 'NL'].includes(String(chosen?.data.country ?? ''));
  return <>
    <PageHeader title="My map" description="Your fields over the official parcel register, coloured by land use: SIGPAC in Spain, BRP in the Netherlands. Choose a parcel to read what is published about it."/>
    {farms.error && <Notice kind="error">{farms.error}</Notice>}
    {farms.items.length > 1 && <div className="dash-picker"><Field label="Farm"><select value={chosen?.id ?? ''} onChange={event => setFarmId(event.target.value)}>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{sampleName(farm.data.name)}</option>)}</select></Field></div>}
    {error && <Notice kind="error">{error}</Notice>}
    {!farms.loading && !farms.items.length ? <Notice>Add your farm first. <Link to="/app/fields">Open My fields</Link></Notice> : chosen && <>
      {!covered && <Notice>The official parcel register for {countryName(chosen.data.country)} is not connected yet. Your own field outlines are shown.</Notice>}
      <SigpacMap key={chosen.id} title={`Map of ${sampleName(chosen.data.name)}`} fields={mapFields} highlight={parcels.map(parcel => parcel.external_id ?? '').filter(Boolean)} onFieldSelect={field => field.href && navigate(field.href)}/>
      <section className="dash-section"><h2>Your fields</h2>
        <Findings items={mapFields.map(field => ({ id: field.id, level: field.status ?? 'ok', title: field.label.split(' · ').slice(1).join(' · ') || field.label, detail: field.detail, href, action: 'Check' }))} empty="No field outlines saved yet. Draw them in My fields."/>
      </section>
    </>}
  </>;
}

export function MyAdviserPage() {
  const { session } = useSession();
  const { farms, chosen, setFarmId } = useFarmChoice();
  const [questions, setQuestions] = useState<RecordItem<Question>[]>([]);
  const [recipients, setRecipients] = useState<{ user_id: string; display_name: string }[]>([]);
  const [recipient, setRecipient] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  const [version, setVersion] = useState(0);
  const owner = session?.workspace.role === 'owner';
  useEffect(() => {
    if (!chosen || !owner) return;
    let active = true;
    api.get<Page<RecordItem<Question>>>(`/adviser/questions?farm_id=${chosen.id}&limit=50`).then(result => { if (active) setQuestions(result.items); }).catch(failure => { if (active) setError(errorMessage(failure)); });
    api.get<{ items: { user_id: string; display_name: string }[] }>(`/adviser/recipients?farm_id=${chosen.id}`).then(result => {
      if (!active) return; setRecipients(result.items); setRecipient(previous => previous || result.items[0]?.user_id || '');
    }).catch(() => { if (active) setRecipients([]); });
    return () => { active = false; };
  }, [chosen?.id, version, owner]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!chosen || !recipient) return;
    setBusy(true); setError(''); setSent('');
    try {
      await api.post('/adviser/questions', { farm_id: chosen.id, recipient_id: recipient, title: title.trim(), body: body.trim() }, { idempotencyKey: crypto.randomUUID() });
      setTitle(''); setBody(''); setSent('Sent to your adviser. Their reply will appear here.'); setVersion(value => value + 1);
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  async function close(item: RecordItem<Question>) {
    setBusy(true); setError('');
    try { await api.post(`/adviser/questions/${item.id}/close`, { expected_revision: item.revision }); setVersion(value => value + 1); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  const nameOf = (id: string) => recipients.find(item => item.user_id === id)?.display_name ?? (id === session?.user.id ? 'You' : 'Your adviser');
  return <>
    <PageHeader title="My adviser" description="Ask your adviser, send them your easy form or a question you are not sure about, and read their replies."/>
    {!owner ? <Notice>Only the farm owner can message the farm's advisers from this workspace.</Notice> : <>
      {farms.items.length > 1 && <div className="dash-picker"><Field label="Farm"><select value={chosen?.id ?? ''} onChange={event => setFarmId(event.target.value)}>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{sampleName(farm.data.name)}</option>)}</select></Field></div>}
      {error && <Notice kind="error">{error}</Notice>}{sent && <Notice kind="success">{sent}</Notice>}
      <section className="panel k-help"><h2>Ask my adviser</h2>
        {!recipients.length ? <p>No adviser has access to this farm yet. Invite one from <Link to="/app/adviser">Adviser access</Link>, then ask here.</p> :
        <form className="stack" onSubmit={send}>
          {recipients.length > 1 && <Field label="Adviser"><select value={recipient} onChange={event => setRecipient(event.target.value)}>{recipients.map(item => <option key={item.user_id} value={item.user_id}>{item.display_name}</option>)}</select></Field>}
          <Field label="Subject"><input required maxLength={180} value={title} onChange={event => setTitle(event.target.value)} placeholder="For example: Is D04 right?"/></Field>
          <Field label="Your question"><textarea required maxLength={8000} rows={4} value={body} onChange={event => setBody(event.target.value)}/></Field>
          <VoiceButton label="Say your question" onText={text => setBody(previous => `${previous ? previous + ' ' : ''}${text}`.slice(0, 8000))}/>
          <div className="actions"><Button type="submit" loading={busy} disabled={!title.trim() || !body.trim()}>Send to my adviser</Button></div>
          <p className="muted">Your adviser helps; the paying agency decides. Nothing here is sent to an authority.</p>
        </form>}
      </section>
      <section className="dash-section"><h2>Conversations</h2>
        {!questions.length ? <p className="dash-empty">No questions yet.</p> : questions.map(item => <article key={item.id} className="dash-thread">
          <header><h3>{item.data.title}</h3><span className={`badge ${item.data.status === 'answered' ? 'badge-success' : item.data.status === 'closed' ? '' : 'badge-warning'}`}>{item.data.status}</span></header>
          <p className="preserve-lines">{item.data.body}</p>
          {item.data.responses.map((reply, index) => <p key={index} className="dash-reply preserve-lines"><strong>{nameOf(reply.author_id)}:</strong> {reply.body}</p>)}
          {item.data.status !== 'closed' && <div className="actions"><Button variant="ghost" disabled={busy} onClick={() => void close(item)}>Close this question</Button></div>}
        </article>)}
      </section>
    </>}
  </>;
}

/* ---------- Adviser ---------- */

type ClientFarm = { workspace: Workspace; farm: RecordItem; issues: Issue[] | null };
function useClientFarms() {
  const [rows, setRows] = useState<ClientFarm[] | null>(null);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    (async () => {
      const clients = await api.get<Page<Workspace>>('/adviser/clients?limit=50');
      const result: ClientFarm[] = [];
      // Only farms this person advises; their own farms live in the Farmer dashboard.
      for (const workspace of clients.items.filter(item => item.role === 'adviser')) {
        const farms = await api.get<Page<RecordItem>>(`/adviser/farms?workspace_id=${workspace.id}&limit=50`);
        if (farms.total > farms.items.length) setTruncated(true);
        for (const farm of farms.items) result.push({ workspace, farm, issues: null });
      }
      if (clients.total > clients.items.length) setTruncated(true);
      if (!active) return;
      setRows(result);
      // Field findings per farm, read inside each client's workspace (the server checks access).
      const checked = await Promise.all(result.map(row => api.getIn<ParcelCheck>(row.workspace.id, parcelCheckPath(row.farm)).then(check => check.issues).catch(() => [] as Issue[])));
      if (active) setRows(result.map((row, index) => ({ ...row, issues: checked[index] })));
    })().catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [version]);
  useEffect(() => {
    // A newly accepted invitation adds a client: read the desk again.
    const changed = () => setVersion(value => value + 1);
    window.addEventListener('workspaces-changed', changed);
    return () => window.removeEventListener('workspaces-changed', changed);
  }, []);
  return { rows, error, truncated, reload: () => setVersion(value => value + 1) };
}
const farmFile = (row: ClientFarm) => `/app/adviser?${new URLSearchParams({ workspace: row.workspace.id, farm: row.farm.id })}`;

export function AdviserOverview() {
  const { rows, error } = useClientFarms();
  const [waiting, setWaiting] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    api.get<Page<Workspace>>('/adviser/clients?limit=50').then(async clients => {
      const counts = await Promise.all(clients.items.filter(workspace => workspace.role === 'adviser').map(workspace =>
        api.getIn<Page<RecordItem<Question>>>(workspace.id, '/adviser/questions?limit=50').then(page => page.items.filter(item => item.data.status === 'open').length).catch(() => 0)));
      if (active) setWaiting(counts.reduce((sum, value) => sum + value, 0));
    }).catch(() => { if (active) setWaiting(0); });
    return () => { active = false; };
  }, []);
  const farms = rows ?? [];
  const checked = farms.filter(row => row.issues);
  const conflicts = checked.filter(row => levelOf(row.issues!) === 'conflict').length;
  const gaps = checked.filter(row => levelOf(row.issues!) === 'gap').length;
  const findings = checked.flatMap(row => issueFindings(row.farm, row.issues!, () => farmFile(row))
    .map(finding => ({ ...finding, title: `${sampleName(row.farm.data.name)} · ${finding.title}` })))
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'conflict' ? -1 : 1));
  return <section className="dash-section" aria-label="Adviser overview">
    {error && <Notice kind="error">{error}</Notice>}
    <StatTiles label="Desk figures" items={[
      { label: 'Farms on my desk', value: rows ? farms.length : '…', detail: rows ? `${new Set(farms.map(row => row.workspace.id)).size} ${new Set(farms.map(row => row.workspace.id)).size === 1 ? 'client workspace' : 'client workspaces'}` : 'Loading', href: '/app/adviser/map', tone: 'farm' },
      { label: 'Waiting for me', value: waiting ?? '…', detail: 'open questions from farmers', href: '/app/adviser/inbox', tone: 'help' },
      { label: 'Need action', value: rows ? conflicts : '…', detail: 'farms with an error finding', href: '/app/adviser/map', tone: conflicts ? 'alert' : 'ok' },
      { label: 'Missing information', value: rows ? gaps : '…', detail: 'farms with warnings only', href: '/app/adviser/map', tone: 'gov' },
    ]}/>
    <h2>Findings across my farms <small className="muted">{findings.length ? `${findings.length} open` : ''}</small></h2>
    <Findings loading={!rows || checked.length < farms.length} items={findings.slice(0, 10)} empty={rows && checked.length === farms.length ? 'No open findings on the farms you can see.' : 'Checking the farms on your desk…'}/>
  </section>;
}

export function AdviserMapPage() {
  const navigate = useNavigate();
  const { rows, error, truncated } = useClientFarms();
  const [colourBy, setColourBy] = useState<'status' | 'landuse'>('status');
  const [focus, setFocus] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(0);
  const fields = useMemo(() => (rows ?? []).flatMap(row => fieldsOnMap(row.farm, (row.farm.data.parcels as Parcel[] | undefined) ?? [], row.issues ?? [], farmFile(row))), [rows]);
  const ordered = [...(rows ?? [])].sort((a, b) => ['conflict', 'gap', 'ok'].indexOf(levelOf(a.issues ?? [])) - ['conflict', 'gap', 'ok'].indexOf(levelOf(b.issues ?? [])));
  // Open on the most urgent farm; "Show all farms" fits every farm again.
  const firstUrgent = ordered.find(row => row.issues)?.farm.id ?? null;
  useEffect(() => { if (firstUrgent && focus === null && rows?.every(row => row.issues)) setFocus(firstUrgent); }, [firstUrgent, rows]);
  return <>
    <PageHeader title="Map" description="Every farm on your desk, coloured by what needs doing, over the official parcel registers of Spain and the Netherlands. Choose a farm to open its file."/>
    {error && <Notice kind="error">{error}</Notice>}
    {truncated && <Notice kind="warning">Showing the first 50 workspaces and farms. Use the Overview search for others.</Notice>}
    <div className="dash-picker">
      <fieldset className="segmented"><legend>Colour by</legend><div className="segmented-options">
        <label><input type="radio" name="adviser-colour" checked={colourBy === 'status'} onChange={() => setColourBy('status')}/>Status</label>
        <label><input type="radio" name="adviser-colour" checked={colourBy === 'landuse'} onChange={() => setColourBy('landuse')}/>Land use</label>
      </div></fieldset>
      <Button variant="secondary" onClick={() => { setFocus(null); setShowAll(value => value + 1); }}>Show all farms</Button>
    </div>
    {!rows ? <Notice>Loading the farms on your desk…</Notice> : !rows.length ? <Notice>No farms yet. Accept a farmer’s invitation from the Overview.</Notice> : <>
      <SigpacMap key={`all-${showAll}`} title="Farms on my desk" fields={fields} colourBy={colourBy} focusGroup={focus} onFieldSelect={field => field.href && navigate(field.href)}/>
      <section className="dash-section"><h2>Farms</h2>
        <ul className="dash-findings">{ordered.map(row => { const level = levelOf(row.issues ?? []); return <li key={row.farm.id} className={`is-${level}`}>
          {(() => { const Icon = level === 'conflict' ? CircleAlert : level === 'gap' ? TriangleAlert : CircleCheck; return <Icon className="dash-finding-icon" aria-hidden="true"/>; })()}
          <div className="dash-finding-text"><span className="dash-finding-level">{row.issues ? statusText[level] : 'checking'}</span><strong>{sampleName(row.farm.data.name)}</strong><span>{String(row.farm.data.country ?? '')} · {row.workspace.name} · {(row.issues ?? []).length} findings</span></div>
          <div className="actions"><Button variant="secondary" onClick={() => setFocus(row.farm.id)}>Show on map</Button><Link className="dash-finding-go" to={farmFile(row)}>Open farm file</Link></div>
        </li>; })}</ul>
      </section>
    </>}
  </>;
}

export function AdviserInboxPage() {
  const { session } = useSession();
  const [items, setItems] = useState<{ workspace: Workspace; question: RecordItem<Question>; farm?: string }[] | null>(null);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    (async () => {
      const clients = await api.get<Page<Workspace>>('/adviser/clients?limit=50');
      const found: { workspace: Workspace; question: RecordItem<Question>; farm?: string }[] = [];
      for (const workspace of clients.items.filter(item => item.role === 'adviser')) {
        const [questions, farms] = await Promise.all([
          api.getIn<Page<RecordItem<Question>>>(workspace.id, '/adviser/questions?limit=50'),
          api.get<Page<RecordItem>>(`/adviser/farms?workspace_id=${workspace.id}&limit=50`),
        ]);
        for (const question of questions.items) found.push({ workspace, question, farm: farms.items.find(farm => farm.id === question.data.farm_id)?.data.name as string | undefined });
      }
      found.sort((a, b) => (a.question.data.status === 'open' ? 0 : 1) - (b.question.data.status === 'open' ? 0 : 1) || b.question.updated_at.localeCompare(a.question.updated_at));
      if (active) setItems(found);
    })().catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [version]);
  async function reply(entry: { workspace: Workspace; question: RecordItem<Question> }) {
    const text = (drafts[entry.question.id] ?? '').trim();
    if (!text) return;
    setBusy(entry.question.id); setError('');
    try {
      await api.postIn(entry.workspace.id, `/adviser/questions/${entry.question.id}/reply`, { expected_revision: entry.question.revision, body: text }, { idempotencyKey: crypto.randomUUID() });
      setDrafts(previous => ({ ...previous, [entry.question.id]: '' })); setVersion(value => value + 1);
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(''); }
  }
  return <>
    <PageHeader title="Inbox" description="Questions and easy forms that farmers sent you. Reply here; the farmer closes the question when it is settled."/>
    {error && <Notice kind="error">{error}</Notice>}
    {!items ? <Notice>Opening your inbox…</Notice> : !items.length ? <p className="dash-empty">Nothing waiting. Farmers’ questions appear here when they press Send to my adviser.</p> : items.map(entry => {
      const { question, workspace } = entry;
      return <article key={question.id} className="dash-thread">
        <header><h3>{question.data.title}</h3><span className={`badge ${question.data.status === 'open' ? 'badge-warning' : question.data.status === 'answered' ? 'badge-success' : ''}`}>{question.data.status}</span></header>
        <p className="muted">{sampleName(entry.farm ?? 'Farm')} · {workspace.name} · {new Date(question.created_at).toLocaleDateString()}</p>
        <p className="preserve-lines">{question.data.body}</p>
        {question.data.responses.map((item, index) => <p key={index} className="dash-reply preserve-lines"><strong>{item.author_id === session?.user.id ? 'You' : 'Farmer'}:</strong> {item.body}</p>)}
        {question.data.status !== 'closed' && <form className="stack" onSubmit={event => { event.preventDefault(); void reply(entry); }}>
          <Field label="Your reply"><textarea rows={3} maxLength={8000} value={drafts[question.id] ?? ''} onChange={event => setDrafts(previous => ({ ...previous, [question.id]: event.target.value }))}/></Field>
          <VoiceButton label="Say your reply" onText={text => setDrafts(previous => ({ ...previous, [question.id]: `${previous[question.id] ? previous[question.id] + ' ' : ''}${text}`.slice(0, 8000) }))}/>
          <div className="actions"><Button type="submit" loading={busy === question.id} disabled={!(drafts[question.id] ?? '').trim()}>Send reply</Button><Link to={`/app/adviser?${new URLSearchParams({ workspace: workspace.id, farm: question.data.farm_id })}`}>Open farm file</Link></div>
        </form>}
      </article>;
    })}
  </>;
}
