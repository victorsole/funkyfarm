import { useEffect, useRef, useState, type FormEvent, type FormHTMLAttributes } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { useSession } from '../auth';
import type { RecordItem } from '../types';
import { usePrivateDraft } from '../offline';
import { FieldMap, FieldBoundaryWorkspace } from './FieldsMap';
import { FundingGuide } from './FundingGuide';
import './farm-work.css';

// Uncontrolled short forms retain entered values without storing account credentials.
// A reset is dispatched only after the server has committed the form's record.
export function DraftForm({ draftKey, children, onChange, ...props }: FormHTMLAttributes<HTMLFormElement> & { draftKey: string }) {
  const draft = usePrivateDraft<Record<string,string | string[]>>(draftKey, {});
  const form = useRef<HTMLFormElement>(null);
  const restored = useRef(false);
  useEffect(() => {
    if (!draft.ready || !form.current || restored.current) return;
    restored.current = true;
    for (const field of Array.from(form.current.elements)) {
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) || !field.name || !(field.name in draft.value)) continue;
      const value = draft.value[field.name];
      if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) field.checked = Array.isArray(value) ? value.includes(field.value) : value === field.value;
      else if (field instanceof HTMLSelectElement && field.multiple) for (const option of Array.from(field.options)) option.selected = Array.isArray(value) ? value.includes(option.value) : value === option.value;
      else if (!(field instanceof HTMLInputElement && field.type === 'file')) field.value = Array.isArray(value) ? value[0] || '' : value;
    }
  }, [draft.ready, draft.value]);
  return <form {...props} ref={form} onReset={() => void draft.clear()} onChange={event => {
    if (form.current) {
      const values: Record<string,string | string[]> = {};
      const data = new FormData(form.current);
      for (const field of Array.from(form.current.elements)) {
        if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) || !field.name || field instanceof HTMLInputElement && ['file','password'].includes(field.type)) continue;
        const entries = data.getAll(field.name).filter((value): value is string => typeof value === 'string');
        values[field.name] = entries.length > 1 ? entries : entries[0] || '';
      }
      draft.setValue(values);
    }
    onChange?.(event);
  }}><fieldset disabled={!draft.ready || props['aria-busy'] === true} className="draft-fields">{children}</fieldset>{!draft.ready && <Notice>Opening your private draft…</Notice>}{draft.saving && <p className="muted" role="status">Saving draft on this device…</p>}{draft.error && <Notice kind="warning">{draft.error}</Notice>}</form>;
}

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const countries = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
const show = (value: unknown) => value === null || value === undefined ? 'Not recorded' : typeof value === 'object' ? JSON.stringify(value) : String(value);

export function useReviewAccess() {
  const { session } = useSession();
  return session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
}

function Failure({ error }: { error: unknown }) {
  if (!error) return null;
  return <Notice kind="error">{errorMessage(error)}{error instanceof ApiError && error.status === 409 && <p>Your entries are still here. Someone saved another version. Load the latest record, compare it with your entries, and save again only after reviewing the difference.</p>}</Notice>;
}

export interface WorkflowHome {
  farm: RecordItem | null;
  farms?: RecordItem[];
  deadlines?: {id:string;title:string;deadline:string;overdue?:boolean;href?:string}[];
  task_preview?: {total:number;dated_total:number;overdue_total:number;due_today_total:number;actions_truncated:boolean;deadlines_truncated:boolean;href:string};
  summary: { open_requests: number; proposed_facts: number; proposed_operations: number; proposed_purchases: number; proposed_sales?:number; upcoming_deadlines: any[] | number };
  next_actions: { id: string; title: string; message: string; href: string; kind: string; priority?: string; count?: number }[];
  missing_information: { code: string; label: string; message: string;href?:string }[];
  annual_review: { year: number; previous_year: number; reusable_count: number; missing_count: number };
  capture_types: { value: string; label: string; unit?: string }[];
}

function farmerPath(path: string) {
  return path.replace('/app/farm', '/app/fields').replace('/app/requests', '/app/paperwork').replace(/^\/app\/record$/, '/app/record-work');
}

function HomeTasks({farmId}:{farmId?:string}) {
  const correction = `/app/cases/new?${new URLSearchParams({ job_type: 'correction', focused: '1', ...(farmId ? { farm_id: farmId } : {}) })}`;
  return <section className="card farm-start"><h2>Are your field details right?</h2><p>Check your fields, see what needs attention and work through each change.</p><p><Link className="button button-primary" to={farmId ? `/app/fields/${farmId}/check` : '/app/fields'}>{farmId ? 'Check my fields' : 'Add or choose my farm'}</Link></p><p><Link to={farmId ? `/app/easy-form?farm_id=${encodeURIComponent(farmId)}` : '/app/easy-form'}>Easy form: fill it in step by step</Link></p><div className="actions"><Link to={correction}>Fix a mistake in filed paperwork</Link><Link to="/app/examples">Try a sample farm</Link></div></section>;
}

export function HomePage() {
  const { session } = useSession();
  const [farmId,setFarmId]=useState('');
  const [home,setHome]=useState<WorkflowHome|null>(null);
  const [error,setError]=useState<unknown>(null);
  const [reload,setReload]=useState(0);
  const [showOtherRecords,setShowOtherRecords]=useState(false);
  useEffect(()=>{
    let active=true;setError(null);setHome(null);
    api.get<WorkflowHome>(`/workflow/home${farmId?`?farm_id=${encodeURIComponent(farmId)}`:''}`).then(result=>{if(active)setHome(result);}).catch(failure=>{if(active)setError(failure);});
    return()=>{active=false;};
  },[farmId,reload]);
  if(!home)return <><PageHeader title="Home" description="A hand with the paperwork, one task at a time."/><Failure error={error}/>{error?<Button onClick={()=>setReload(value=>value+1)}>Try again</Button>:<Notice>Checking your saved tasks…</Notice>}</>;
  if(!home.farm)return <><PageHeader title="Start with your farm" description="Add your farm once, then check its fields and paperwork."/>{session?.workspace.role==='owner'?<OnboardingForm/>:<Notice>No farm is available through your current permission. Ask the farm owner to check your invitation.</Notice>}<p><Link to="/app/examples">Try a sample farm first</Link></p></>;
  const deadlines=home.deadlines||(Array.isArray(home.summary.upcoming_deadlines)?home.summary.upcoming_deadlines:[]);
  const first=home.next_actions[0];
  const missing=home.missing_information;
  return <>
    <PageHeader title={`Home at ${home.farm.data.name}`} description="Choose a task, or pick up where you left off."/>
    {(home.farms?.length||0)>1&&<Field label="Farm"><select value={farmId||home.farm.id} onChange={event=>setFarmId(event.target.value)}>{home.farms?.map(farm=><option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field>}
    <HomeTasks farmId={home.farm.id}/>
    <p className="farm-demo-entry"><strong>Hackathon demo</strong><span>Follow a Spanish farm from field checks to a correction folder.</span><Link to="/app/demo">Open the guided demo</Link></p>
    {!!home.task_preview?.overdue_total && <Notice kind="warning">{home.task_preview.overdue_total} saved {home.task_preview.overdue_total === 1 ? 'task is' : 'tasks are'} overdue. <Link to={`/app/tasks?farm_id=${home.farm.id}`}>Read the tasks and dates</Link></Notice>}
    <details className="card" onToggle={event => setShowOtherRecords(event.currentTarget.open)}><summary>Saved tasks, dates and other farm records</summary>{showOtherRecords && <>
    {home.farm.data.country === 'PT' && <section className="card"><h2>Crop-protection records</h2><p>Save the details while they are fresh, check each row and prepare your Portuguese record when you need it.</p><Link className="button button-secondary" to={`/app/record-work?farm_id=${home.farm.id}#portuguese-journal`}>Open the Portuguese journal</Link></section>}
    <section id="next-task" className="farm-next"><h2>Your next step</h2>{first?<article className="card"><p className="eyebrow">From your saved records</p><h3>{first.title}</h3><p>{first.message}</p><Link className="button button-primary" to={farmerPath(first.href)}>{first.title}</Link>{home.next_actions.length>1&&<details><summary>What else needs attention?</summary><ul className="farm-plain-list">{home.next_actions.slice(1,3).map(action=><li key={action.id}><div><strong>{action.title}</strong><p>{action.message}</p></div><Link to={farmerPath(action.href)}>Open task</Link></li>)}</ul></details>}</article>:<div className="card"><h3>No outstanding task in your saved records</h3><p>Add a work note, purchase, sale or letter when you have one to record.</p><Link className="button button-secondary" to={`/app/record-work?farm_id=${home.farm.id}`}>Record work, a purchase or a sale</Link></div>}</section>
    <div className="two-column"><section className="card"><h2>Dates to keep in mind</h2>{deadlines.length?<ul className="farm-plain-list">{deadlines.slice(0,5).map((deadline:any,index:number)=><li key={deadline.id||index}><div><strong>{deadline.title||'Paperwork deadline'}</strong><p>{deadline.deadline||deadline.due_date||deadline.date}{deadline.overdue?' · overdue':''}</p></div>{deadline.id&&<Link to={farmerPath(deadline.href||`/app/paperwork/${deadline.id}`)}>Open paperwork</Link>}</li>)}</ul>:<p className="muted">No deadline is recorded for this farm.</p>}<Link to={`/app/paperwork?farm_id=${home.farm.id}`}>All paperwork</Link></section><section className="card"><h2>Records still needed</h2>{missing.length?<ul>{missing.slice(0,4).map((item,index)=><li key={`${item.code}:${index}`}><strong>{item.label}</strong><p>{item.message}</p>{item.href&&<Link to={farmerPath(item.href)}>Add the missing details</Link>}</li>)}</ul>:<p className="muted">No missing answer is recorded against your current paperwork. New requirements may still need review.</p>}{(home.summary.proposed_sales||0)>0&&<p><Link to={`/app/record-work?farm_id=${home.farm.id}&review=1`}>Check {home.summary.proposed_sales} saved {home.summary.proposed_sales===1?'sale':'sales'}</Link> before using the figures in paperwork.</p>}<Link to={`/app/documents?farm_id=${home.farm.id}`}>Add a notebook photo, letter or invoice</Link></section></div>
    <HomeChecks farmId={home.farm.id}/>
    <section className="card"><h2>Tasks and questions</h2>{home.task_preview ? <p>{home.task_preview.total} unfinished{home.task_preview.overdue_total ? `, ${home.task_preview.overdue_total} overdue` : ''}{home.task_preview.due_today_total ? `, ${home.task_preview.due_today_total} due today` : ''}.{(home.task_preview.actions_truncated || home.task_preview.deadlines_truncated) && ' Home shows only the nearest tasks and dates.'}</p> : <p>Read and answer questions from your adviser, or follow up on saved tasks.</p>}<Link to={`/app/tasks?farm_id=${home.farm.id}`}>Open tasks and questions</Link></section>
    <FundingGuide key={`${session?.user.id}:${session?.workspace.id}:${home.farm.id}`} farmId={home.farm.id}/>
    <details className="card"><summary>Prepare this year's application</summary><p>Review the standing details you already recorded, then check this year's actual figures.</p><Link className="button button-secondary" to={`/app/fields/${home.farm.id}#annual-review`}>Review this year's answers</Link></details>
    </>}</details>
  </>;
}

interface FarmChecksHome {
  overall:'ready_for_review'|'needs_information'|'needs_adviser';
  profile_questions:any[];
  obligations:{id:string;title:string;applicability:string;status:string;requirements:any[];deadline:{date:string|null;message:string;status:string};steps:{id:string;title:string;message:string;status:string;href:string;kind:string}[];limits:string[]}[];
  issues:{code:string;severity:string;message:string;href?:string}[];
}
function HomeChecks({farmId}:{farmId:string}) {
  const [checks,setChecks]=useState<FarmChecksHome|null>(null);
  const [error,setError]=useState<unknown>(null);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true;setChecks(null);setError(null);
    api.get<FarmChecksHome>(`/compliance/farms/${farmId}`).then(result=>{if(active)setChecks(result);}).catch(failure=>{if(active)setError(failure);});
    return()=>{active=false;};
  },[farmId,revision]);
  const relevant=checks?.obligations.filter(obligation=>obligation.applicability!=='does_not_apply')||[];
  const next=relevant.find(obligation=>obligation.status!=='ready_for_review')||relevant[0];
  const step=next?.steps.find(item=>!['done','complete','completed'].includes(item.status));
  return <section className="card"><h2>Check what applies to your farm</h2><Failure error={error}/>{error!==null&&<Button variant="secondary" onClick={()=>setRevision(value=>value+1)}>Try the farm checks again</Button>}{!checks&&error===null&&<Notice>Checking the saved farm details and requirements…</Notice>}{checks&&<><p>{checks.overall==='needs_adviser'?'One or more requirements need an adviser’s review.':checks.overall==='ready_for_review'?'The available records are ready for you to review. This is not an authority decision.':'Some requirements still need an answer or a supporting record.'}</p>{checks.profile_questions.length>0&&<p>Answer the farm questions to establish which requirements apply.</p>}{next&&<article className="panel"><h3>{next.title}</h3>{next.applicability==='unknown'||next.applicability==='conflict'?<p>Check whether this requirement applies before preparing the response.</p>:<p>{step?.message||'Check the saved answers and original records for this requirement.'}</p>}{next.deadline?.date&&<p>Recorded deadline: {next.deadline.date}</p>}<Link className="button button-secondary" to={farmerPath(step?.href||`/app/checks?farm_id=${farmId}`)}>{step?.title||'Check this requirement'}</Link></article>}{checks.issues.slice(0,2).map((issue,index)=><p key={`${issue.code}:${index}`}>{issue.message}{issue.href&&<> <Link to={farmerPath(issue.href)}>Open the relevant record</Link></>}</p>)}<p><Link to={`/app/checks?farm_id=${farmId}`}>See all farm checks and required records</Link></p></>}</section>;
}

type SetupDraft = { capture_id:string; name: string; country: string; region: string; farm_type: string; reporting_year: string; starting: string; document_ids: string[] };
function OnboardingForm({task}:{task?:string|null}) {
  const navigate = useNavigate();
  const documents = useRecords('documents');
  const draft = usePrivateDraft<SetupDraft>('farm-onboarding', { capture_id:crypto.randomUUID(), name: '', country: '', region: '', farm_type: '', reporting_year: String(new Date().getFullYear()), starting: 'last_application', document_ids: [] });
  const [step,setStep] = useState(1);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<unknown>(null);
  const value = draft.value;
  function set<K extends keyof SetupDraft>(key: K, next: SetupDraft[K]) { draft.setValue(previous => ({ ...previous, [key]: next })); }
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === 1 && !task) { setStep(2); return; }
    setBusy(true); setError(null);
    try {
      const result = await api.post<{ farm: RecordItem }>('/workflow/onboard', {
        name: value.name.trim(), country: value.country, region: value.region.trim() || null,
        farm_type: value.farm_type, reporting_year: Number(value.reporting_year), previous_document_ids: value.document_ids
      }, {idempotencyKey:value.capture_id});
      await draft.clear();
      const farm = encodeURIComponent(result.farm.id);
      const destination = task==='letter'?`/app/documents?farm_id=${farm}&purpose=letter`:task==='fields'?`/app/fields/${farm}`:task==='support'?`/app/paperwork?farm_id=${farm}&intent=support`:task==='inspection'?`/app/paperwork?farm_id=${farm}&intent=inspection`:task==='next'?'/app/home':value.starting === 'import' ? `/app/imports?farm_id=${farm}` : value.starting === 'adviser' ? `/app/advisers?farm_id=${farm}` : `/app/documents?farm_id=${farm}&purpose=${value.starting}`;
      navigate(destination);
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <section className="card farm-setup"><p className="eyebrow">Step {step} of {task?1:2}</p><h2>{step === 1 ? 'Where and what do you farm?' : 'What would you like to start with?'}</h2><Failure error={error}/>{draft.error && <Notice kind="warning">{draft.error}</Notice>}{!draft.ready && <Notice>Opening your saved setup…</Notice>}<form onSubmit={start} className="stack"><fieldset disabled={!draft.ready || busy} className="draft-fields">
    {step === 1 ? <div className="form-grid"><Field label="Farm name"><input value={value.name} onChange={e => set('name',e.target.value)} required maxLength={200} autoComplete="organization"/></Field><Field label="Country"><select value={value.country} onChange={e => set('country',e.target.value)} required><option value="">Choose your country</option>{countries.map(country => <option key={country} value={country}>{countryNames.of(country)}</option>)}</select></Field><Field label="Region or state"><input value={value.region} onChange={e => set('region',e.target.value)} placeholder="If relevant to your application" maxLength={200}/></Field><Field label="What kind of farm?"><select value={value.farm_type} onChange={e => set('farm_type',e.target.value)} required><option value="">Choose a farm type</option><option value="arable">Arable crops</option><option value="livestock">Livestock</option><option value="mixed">Crops and livestock</option><option value="horticulture">Fruit, vegetables or horticulture</option><option value="other">Another type of farm</option></select></Field><Field label="Year you are preparing for"><input type="number" min="1900" max="2200" value={value.reporting_year} onChange={e => set('reporting_year',e.target.value)} required/></Field></div> : <><div className="farm-start-choices">{[{value:'last_application',title:"Last year's application",description:'Start with the details you already sent. You will check what has changed.'},{value:'import',title:'An export from another tool',description:'Bring a CSV from your farm software or spreadsheet.'},{value:'records',title:'A notebook, receipt or letter',description:'Add a scan, photograph or document and review the suggested entries.'},{value:'adviser',title:'Help from my adviser',description:'Invite a named person and choose which farms they may see.'}].map(choice => <label className={`farm-start-choice ${value.starting === choice.value ? 'is-selected' : ''}`} key={choice.value}><input type="radio" name="starting" value={choice.value} checked={value.starting === choice.value} onChange={() => set('starting',choice.value)}/><span><strong>{choice.title}</strong><small>{choice.description}</small></span></label>)}</div>{value.starting === 'last_application' && documents.items.length > 0 && <details><summary>Already added last year's application?</summary>{documents.items.map(document => <label className="field" key={document.id}><span><input type="checkbox" checked={value.document_ids.includes(document.id)} onChange={e => set('document_ids',e.target.checked ? [...value.document_ids,document.id] : value.document_ids.filter(id => id !== document.id))}/> {document.data.filename || document.data.title || 'Document'}</span></label>)}</details>}<p className="muted">Your original files will be kept. Suggested answers need your review before they are used.</p></>}
    <div className="actions">{step === 2 && <Button variant="secondary" onClick={() => setStep(1)}>Back</Button>}<Button type="submit" loading={busy}>{step === 1 ? task?'Save farm and continue':'Continue' : value.starting === 'adviser' ? 'Set up farm and invite adviser' : value.starting === 'import' ? 'Set up farm and import records' : 'Set up farm and add document'}</Button></div></fieldset>{draft.saving && <p className="muted" role="status">Saving your setup on this device…</p>}</form></section>;
}

export function FarmPage() {
  const { session } = useSession();
  const requestedTask=new URLSearchParams(useLocation().search).get('task');
  const task=['letter','fields','support','inspection','next'].includes(requestedTask||'')?requestedTask:null;
  const farms = useRecords('farms');
  return <><PageHeader title="My fields" description="Use the names you know from the farm. Keep this year's crops and field changes together." />{farms.error && <Notice kind="error">{farms.error}<Button onClick={() => void farms.reload()}>Try again</Button></Notice>}{farms.loading ? <Notice>Opening your farms…</Notice> : farms.items.length ? <ul className="farm-plain-list card">{farms.items.map(farm => <li key={farm.id}><div><h2><Link to={`/app/fields/${farm.id}`}>{farm.data.name}</Link></h2><p>{countryNames.of(farm.data.country)}{farm.data.region ? ` · ${farm.data.region}` : ''}</p></div><div className="actions"><Link className="button button-primary" to={`/app/fields/${farm.id}/check`}>Check my fields</Link><Link to={`/app/fields/${farm.id}`}>Field records and tools</Link></div></li>)}</ul> : null}{session?.workspace.role === 'owner' && (farms.items.length ? <details className="card"><summary>Add another farm</summary><OnboardingForm task={task}/></details> : !farms.loading && <OnboardingForm task={task}/>)}{!farms.loading && !farms.items.length && session?.workspace.role !== 'owner' && <Notice>No farm is available through your current permission. Ask the owner to check your access.</Notice>}</>;
}

export function FarmDetailPage() {
  const location=useLocation();
  const { session } = useSession();
  const owner = session?.workspace.role === 'owner';
  const { id } = useParams();
  const [farm,setFarm] = useState<RecordItem | null>(null);
  const [error,setError] = useState<unknown>(null);
  const [busy,setBusy] = useState(false);
  const [saved,setSaved] = useState('');
  const [latest,setLatest] = useState<RecordItem | null>(null);
  const facts = useRecords(`facts?farm_id=${encodeURIComponent(id || '')}`);
  useEffect(() => {
    if (!farm || !['#facts','#annual-review'].includes(location.hash)) return;
    const section=document.getElementById(location.hash.slice(1));
    if (section instanceof HTMLDetailsElement) section.open=true;
    section?.scrollIntoView({block:'start'});
  },[farm?.id,facts.loading,location.hash]);
  useEffect(() => {
    let active = true; setFarm(null); setError(null);
    api.get<RecordItem>(`/farms/${id}`).then(result => { if (active) setFarm(result); }).catch(failure => { if (active) setError(failure); });
    return () => { active = false; };
  }, [id]);
  async function update(data: Record<string,unknown>, form?:HTMLFormElement) {
    if (!farm) return;
    setBusy(true); setError(null); setSaved('');
    try {const next=await api.patch<RecordItem>(`/farms/${farm.id}`,{expected_revision:farm.revision,data});form?.reset();setFarm(next);setLatest(null);setSaved('Farm details saved.');}
    catch (failure) {setError(failure);} finally {setBusy(false);}
  }
  if (!farm) return <><PageHeader title="My fields"/><Failure error={error}/>{!error && <Notice>Opening your fields…</Notice>}<Link to="/app/fields">Back to farms</Link></>;
  const ownFacts = facts.items.filter(fact => fact.data.farm_id === id);
  return <><PageHeader title={farm.data.name} description={`${countryNames.of(farm.data.country)}${farm.data.region ? ` · ${farm.data.region}` : ''}`} action={<Link className="button button-primary" to={`/app/fields/${farm.id}/check`}>Check my fields</Link>}/><Link to="/app/fields">All my farms</Link><Failure error={error}/>{saved && <Notice kind="success">{saved}</Notice>}
    {error instanceof ApiError && error.status === 409 && <section className="card"><Button variant="secondary" onClick={async () => {try {setLatest(await api.get<RecordItem>(`/farms/${id}`));} catch (failure) {setError(failure);}}}>Compare with the latest saved details</Button>{latest && <><dl><dt>Farm name</dt><dd>{latest.data.name}</dd><dt>Country</dt><dd>{latest.data.country}</dd><dt>Region</dt><dd>{latest.data.region || 'Not recorded'}</dd><dt>Year</dt><dd>{latest.data.reporting_year}</dd></dl><Button variant="secondary" onClick={() => {setFarm(latest);setLatest(null);setError(null);}}>Start again from these details</Button></>}</section>}
    <FieldNotebook farm={farm} onSaved={setFarm}/>
    <AnnualReview farm={farm} onChanged={facts.reload}/>
    <details className="card"><summary>Farm details</summary>{owner ? <DraftForm key={`${farm.id}:${farm.revision}`} draftKey={`farm-profile:${farm.id}`} className="stack" onSubmit={event => {event.preventDefault();const form = new FormData(event.currentTarget);void update({name:form.get('name'),country:form.get('country'),region:form.get('region') || null,reporting_year:Number(form.get('reporting_year')),farm_type:form.get('farm_type')},event.currentTarget);}}><div className="form-grid"><Field label="Farm name"><input name="name" defaultValue={farm.data.name} required/></Field><Field label="Country"><select name="country" defaultValue={farm.data.country}>{countries.map(country => <option key={country} value={country}>{countryNames.of(country)}</option>)}</select></Field><Field label="Region"><input name="region" defaultValue={farm.data.region || ''}/></Field><Field label="Farm type"><select name="farm_type" defaultValue={farm.data.farm_type || ''} required><option value="">Choose your farm type</option><option value="arable">Arable crops</option><option value="livestock">Livestock</option><option value="mixed">Crops and livestock</option><option value="horticulture">Fruit, vegetables or horticulture</option><option value="other">Another type of farm</option></select></Field><Field label="Reporting year"><input name="reporting_year" type="number" min="1900" max="2200" defaultValue={farm.data.reporting_year || new Date().getFullYear()} required/></Field></div><Button type="submit" loading={busy}>Save farm details</Button></DraftForm> : <p>{farm.data.name} · {farm.data.region || 'Region not recorded'} · {farm.data.reporting_year}</p>}</details>
    <details id="facts" className="card"><summary>Check answers saved about this farm</summary><p>Check proposed answers against the original file or your farm records before confirming them.</p><FactConflicts farmId={farm.id} version={ownFacts.map(fact => `${fact.id}:${fact.revision}`).join(',')}/>{facts.error && <Notice kind="error">{facts.error}</Notice>}{facts.loading && <Notice>Opening saved answers…</Notice>}{!facts.loading && !ownFacts.length && <p className="muted">No answers saved yet. Start with last year's application or a farm record.</p>}{ownFacts.map(fact => <FactReview key={`${fact.id}:${fact.revision}`} fact={fact} reload={facts.reload}/>)}<details><summary>Add an answer by hand</summary><FactForm farmId={farm.id} reload={facts.reload}/></details></details>
    <section className="card"><h2>Work and purchases</h2><p>Record what you bought separately from what you used, with the date and field you worked on.</p><Link className="button button-secondary" to={`/app/record-work?farm_id=${farm.id}`}>Open my work notebook</Link></section>
  </>;
}

function AnnualReview({farm,onChanged}:{farm:RecordItem;onChanged:()=>Promise<void>}) {
  const [year,setYear]=useState(String(farm.data.reporting_year||new Date().getFullYear()));
  const [review,setReview]=useState<any>(null);
  const [error,setError]=useState<unknown>(null);
  const [generation,setGeneration]=useState(0);
  useEffect(()=>{
    let active=true;setReview(null);setError(null);
    api.get(`/workflow/annual-review?farm_id=${farm.id}&year=${encodeURIComponent(year)}`).then(result=>{if(active)setReview(result);}).catch(failure=>{if(active)setError(failure);});
    return()=>{active=false;};
  },[farm.id,year,generation]);
  return <details className="card" id="annual-review"><summary>What changed since last year?</summary><p>Review the answers already saved about your farm. Last year's costs, payments and work amounts need this year's actual figures.</p><Field label="Year you are preparing for"><input type="number" min="1901" max="2200" value={year} onChange={event=>setYear(event.target.value)}/></Field><Failure error={error}/>{!review&&!error&&<Notice>Opening last year's answers…</Notice>}{review&&!review.items.length&&<p>No checked answers are available from the previous year yet. <Link to={`/app/documents?farm_id=${farm.id}&purpose=last_application`}>Add last year's application</Link> or <Link to={`/app/imports?farm_id=${farm.id}`}>import your records</Link> to start.</p>}{review?.items.map((item:any)=><AnnualQuestion key={`${year}:${item.source.id}:${item.source.revision}`} farm={farm} year={Number(year)} item={item} saved={async()=>{setGeneration(value=>value+1);await onChanged();}}/>)}</details>;
}

function AnnualQuestion({farm,year,item,saved}:{farm:RecordItem;year:number;item:any;saved:()=>Promise<void>}) {
  const canReview=useReviewAccess();
  const source:RecordItem=item.source;
  const draft=usePrivateDraft(`annual:${farm.id}:${year}:${source.id}`,{decision:item.can_reuse?'reuse':'changed',value:'',value_type:typeof source.data.value==='number'?'number':typeof source.data.value==='boolean'?'boolean':'text',unit:source.data.unit||'',note:'',capture_id:crypto.randomUUID()});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<unknown>(null);
  const value=draft.value;
  const resolved=item.review||item.status==='already_recorded';
  return <article className="panel stack"><h3>{item.label}</h3><p>{source.data.temporal_basis==='static'?'Standing farm detail':`${year-1} answer`}: <strong>{show(source.data.value)}</strong> {source.data.unit||''}</p><p>{item.message}</p><details><summary>Where did the previous answer come from?</summary><p>Saved {new Date(source.updated_at).toLocaleDateString()} · {item.source_age_days} days ago</p><pre>{JSON.stringify(source.data.sources||[],null,2)}</pre></details>{resolved?<p>Review saved{item.review?` — ${{reuse:'the answer still applies',changed:'a changed answer was proposed',not_applicable:'marked as not applicable'}[item.review.data.decision as 'reuse'|'changed'|'not_applicable']||item.review.data.decision}`:'. An answer for this year already exists.'}. <Link to={`#facts`}>Check the saved answers below</Link></p>:item.status==='conflict'?<Notice kind="warning">Earlier records give different answers. <a href="#facts">Compare their original records below</a> before reusing an answer.</Notice>:!canReview?<p className="muted">Review permission is needed to record this decision.</p>:<form className="stack" onSubmit={async event=>{event.preventDefault();setBusy(true);setError(null);try{const body:Record<string,unknown>={farm_id:farm.id,year,source_fact_id:source.id,expected_source_revision:source.revision,decision:value.decision,note:value.note};if(value.decision==='changed'){let next:unknown=value.value;if(value.value_type==='unknown')next=null;else if(value.value_type==='boolean'){if(!['true','false'].includes(value.value))throw new Error('Choose yes or no.');next=value.value==='true';}else if(value.value_type==='number'){if(!value.value.trim()||!Number.isFinite(Number(value.value.replace(',','.'))))throw new Error('Enter the actual number, or choose unknown.');next=Number(value.value.replace(',','.'));}body.value=next;body.unit=value.unit||null;}await api.post('/workflow/annual-review',body,{idempotencyKey:value.capture_id});await draft.clear();await saved();}catch(failure){setError(failure);}finally{setBusy(false);}}}><Failure error={error}/>{draft.error&&<Notice kind="warning">{draft.error}</Notice>}<fieldset disabled={!draft.ready||busy} className="draft-fields"><Field label={`Does this still describe your farm for ${year}?`}><select value={value.decision} onChange={event=>draft.setValue(previous=>({...previous,decision:event.target.value}))}>{item.can_reuse&&<option value="reuse">Yes, this answer still applies</option>}<option value="changed">The answer has changed, or I have a new actual figure</option><option value="not_applicable">This does not apply to this year's application</option></select></Field>{value.decision==='changed'&&<div className="form-grid"><Field label={`Answer for ${year}`}>{value.value_type==='boolean'?<select value={value.value} onChange={event=>draft.setValue(previous=>({...previous,value:event.target.value}))} required><option value="">Choose yes or no</option><option value="true">Yes</option><option value="false">No</option></select>:<input value={value.value} onChange={event=>draft.setValue(previous=>({...previous,value:event.target.value}))} required={value.value_type!=='unknown'}/>}</Field><Field label="Kind of answer"><select value={value.value_type} onChange={event=>draft.setValue(previous=>({...previous,value_type:event.target.value}))}><option value="number">A number</option><option value="text">Text</option><option value="boolean">Yes or no</option><option value="unknown">Unknown</option></select></Field><Field label="Unit (if relevant)"><input value={value.unit} onChange={event=>draft.setValue(previous=>({...previous,unit:event.target.value}))}/></Field></div>}<Field label="What did you check?"><textarea value={value.note} onChange={event=>draft.setValue(previous=>({...previous,note:event.target.value}))} required/></Field><p className="muted">New or changed answers remain proposed until you check and confirm them.</p><Button type="submit" loading={busy}>Save my answer</Button></fieldset>{draft.saving&&<p className="muted" role="status">Saving draft on this device…</p>}</form>}</article>;
}

function FieldNotebook({ farm, onSaved }: { farm: RecordItem; onSaved: (farm: RecordItem) => void }) {
  const canReview = useReviewAccess();
  const [fields,setFields] = useState<any[]>([]);
  const [fieldsLoading,setFieldsLoading] = useState(true);
  const [selected,setSelected] = useState<any | null>(null);
  const [adding,setAdding] = useState(false);
  const [error,setError] = useState<unknown>(null);
  const [reload,setReload] = useState(0);
  const revealedEditor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!adding && !selected) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = revealedEditor.current;
      if (!panel) return;
      panel.focus({ preventScroll: true });
      panel.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [adding, selected]);
  useEffect(() => {
    let active = true;setFieldsLoading(true);
    api.get<{items:any[]}>(`/farms/${farm.id}/fields`).then(result => {if (active) setFields(result.items);}).catch(failure => {if (active) setError(failure);}).finally(()=>{if(active)setFieldsLoading(false);});
    return () => {active = false;};
  }, [farm.id,farm.revision,reload]);
  return <section className="farm-fields"><div className="farm-section-heading"><h2>Fields you know</h2>{canReview && <Button onClick={() => {setSelected(null);setAdding(true);}}>Add a field</Button>}</div><p className="muted">Your field names and locations help connect each work record to the right place.</p><Failure error={error}/>{error!==null && <Button variant="secondary" onClick={async () => {try {onSaved(await api.get(`/farms/${farm.id}`));setError(null);setReload(value=>value+1);}catch(failure){setError(failure);}}}>Load current field details</Button>}{fieldsLoading && <Notice>Opening your saved fields…</Notice>}{!fieldsLoading && !fields.length && <div className="card"><h3>No fields recorded yet</h3><p>Start with a familiar name such as “By the road”. Add coordinates or a boundary file if you have them.</p>{canReview && <Button variant="secondary" onClick={() => setAdding(true)}>Add my first field</Button>}</div>}<div className="farm-field-grid">{fields.map((field,index) => <article className="card farm-field-card" key={field.id || index}><FieldMap geometry={field.geometry} point={field.point} label={field.name}/><h3>{field.name}</h3><p>{field.crop || 'Crop not recorded'}{field.greenhouse ? ' · Greenhouse' : ''}</p><p>{field.approximate_area_ha == null ? field.point ? 'A supplied location, without a field boundary' : 'No boundary supplied' : `About ${Number(field.approximate_area_ha).toLocaleString(undefined,{maximumFractionDigits:2})} ha from the supplied boundary`}</p><div className="actions"><Link className="button button-secondary" to={`/app/record-work?farm_id=${farm.id}&field=${encodeURIComponent(field.name)}`}>Record work here</Link>{canReview && <Button variant="ghost" onClick={() => {setAdding(false);setSelected(field);}}>Change field details</Button>}</div></article>)}</div>
    {canReview && (adding || selected) && <div ref={revealedEditor} className="farm-reveal-panel" tabIndex={-1} aria-label={selected ? 'Change field details' : 'Add a field'}><FieldChangeForm key={selected?.id || 'new'} farm={farm} field={selected} close={() => {setAdding(false);setSelected(null);}} saved={async () => {setReload(value=>value+1);setAdding(false);setSelected(null);}}/></div>}
    <FieldBoundaryWorkspace key={`${farm.id}:${reload}`} farm={farm} onSaved={onSaved}/></section>;
}

type FieldDraft = {capture_id:string;name:string;crop:string;latitude:string;longitude:string;geometry:string;greenhouse:boolean;note:string;external_id:string};
function FieldChangeForm({farm,field,close,saved}:{farm:RecordItem;field:any;close:()=>void;saved:()=>Promise<void>}) {
  const initial: FieldDraft = {capture_id:crypto.randomUUID(),name:field?.name || '',crop:field?.crop || '',latitude:field?.point?.latitude === undefined ? '' : String(field.point.latitude),longitude:field?.point?.longitude === undefined ? '' : String(field.point.longitude),geometry:field?.geometry ? JSON.stringify(field.geometry,null,2) : '',greenhouse:field?.greenhouse === true,note:'',external_id:field?.external_id || ''};
  const draft = usePrivateDraft<FieldDraft>(`field-change:${farm.id}:${field?.id || 'new'}`,initial);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<unknown>(null);
  const value=draft.value;
  function set<K extends keyof FieldDraft>(key:K,next:FieldDraft[K]) {draft.setValue(previous=>({...previous,[key]:next}));}
  async function propose(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setError(null);
    try {
      if ((value.latitude.trim()==='') !== (value.longitude.trim()==='')) throw new Error('Enter both latitude and longitude, or leave both empty.');
      const parcel: Record<string,unknown> = {name:value.name.trim(),crop:value.crop.trim() || null,greenhouse:value.greenhouse,external_id:value.external_id.trim() || null};
      if (field?.id) parcel.id=field.id;
      if (value.geometry.trim()) {
        let geometry=JSON.parse(value.geometry);
        if (geometry.type==='Feature') geometry=geometry.geometry;
        if (geometry.type==='FeatureCollection') {if(geometry.features?.length!==1) throw new Error('Choose a GeoJSON file containing one field, or add each field separately.');geometry=geometry.features[0].geometry;}
        parcel.geometry=geometry;
      }
      if (value.latitude.trim()) {
        const latitude=Number(value.latitude.replace(',','.'));const longitude=Number(value.longitude.replace(',','.'));
        if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude < -90||latitude > 90||longitude < -180||longitude > 180) throw new Error('Check the coordinates. Latitude must be between -90 and 90, and longitude between -180 and 180.');
        parcel.point={latitude,longitude};
      }
      await api.post(`/farms/${farm.id}/field-proposals`,{expected_revision:farm.revision,parcel,note:value.note.trim()},{idempotencyKey:value.capture_id});
      await draft.clear();await saved();
    } catch(failure) {setError(failure);} finally {setBusy(false);}
  }
  return <section className="card farm-field-editor"><h3>{field ? `Changes to ${field.name}` : 'Add a field'}</h3><p>Save the proposed details, then check them before they replace the saved field.</p><Failure error={error}/>{draft.error&&<Notice kind="warning">{draft.error}</Notice>}<form onSubmit={propose} className="stack"><fieldset disabled={!draft.ready||busy} className="draft-fields"><div className="form-grid"><Field label="The name you use for this field"><input value={value.name} onChange={event=>set('name',event.target.value)} required maxLength={200} placeholder="For example, By the road"/></Field><Field label="Crop this year"><input value={value.crop} onChange={event=>set('crop',event.target.value)}/></Field></div><label><input type="checkbox" checked={value.greenhouse} onChange={event=>set('greenhouse',event.target.checked)}/> This is a greenhouse</label><details><summary>Add a location, boundary or official reference</summary><div className="form-grid"><Field label="Latitude (optional)"><input inputMode="decimal" value={value.latitude} onChange={event=>set('latitude',event.target.value)} placeholder="For example, 52.5200"/></Field><Field label="Longitude (optional)"><input inputMode="decimal" value={value.longitude} onChange={event=>set('longitude',event.target.value)} placeholder="For example, 13.4050"/></Field></div><Field label="GeoJSON boundary file"><input type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>2*1024*1024)throw new Error('Choose a GeoJSON file smaller than 2 MiB.');const contents=await file.text();JSON.parse(contents);set('geometry',contents);setError(null);}catch(failure){setError(failure);}}}/></Field><Field label="GeoJSON boundary"><textarea rows={6} value={value.geometry} onChange={event=>set('geometry',event.target.value)} spellCheck={false}/></Field><Field label="Official field reference (optional)"><input value={value.external_id} onChange={event=>set('external_id',event.target.value)}/></Field><p className="muted">A location point is not a boundary. Areas calculated from a supplied boundary are approximate.</p></details><Field label="What changed, or where did these details come from?"><textarea value={value.note} onChange={event=>set('note',event.target.value)} required/></Field><div className="actions"><Button type="submit" loading={busy}>Save proposed field details</Button><Button variant="secondary" onClick={close}>Close</Button></div></fieldset>{draft.saving&&<p className="muted" role="status">Saving draft on this device…</p>}</form></section>;
}

function FactForm({ farmId, reload, previous }: { farmId: string; reload: () => Promise<void>; previous?: RecordItem }) {
  const canReview = useReviewAccess();
  const [error, setError] = useState<unknown>(null); const [busy,setBusy] = useState(false); const [success,setSuccess] = useState(false);
  const original = previous?.data.value;
  const originalType = original === null ? 'null' : typeof original === 'boolean' ? 'boolean' : typeof original === 'number' ? 'number' : Array.isArray(original) && original.every(item => typeof item === 'string' && !item.includes('\n')) ? 'list' : typeof original === 'object' ? 'json' : 'text';
  const initialValue = original == null ? '' : originalType === 'list' ? original.join('\n') : originalType === 'boolean' ? original ? 'yes' : 'no' : originalType === 'json' ? JSON.stringify(original, null, 2) : String(original);
  const startingValue = { label: previous?.data.label || '', key: previous?.data.key || '', value: initialValue, value_type: originalType, unit: previous?.data.unit || '', period: previous?.data.period || '', temporal_basis: previous?.data.temporal_basis || 'static', note: '', base_revision: String(previous?.revision ?? 0) };
  const draft = usePrivateDraft<Record<string, string>>(`fact:${farmId}:${previous?.id || 'new'}`, startingValue);
  const value = draft.value;
  const type = value.value_type || originalType;
  const baseRevision = Number(value.base_revision ?? -1);
  const stale = !!previous && baseRevision !== previous.revision;
  const [compared, setCompared] = useState(false);
  useEffect(() => { setCompared(false); }, [previous?.revision, value.base_revision]);
  const set = (key: string, next: string) => draft.setValue(old => ({ ...old, [key]: next }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !draft.ready) return;
    setError(null); setSuccess(false); setBusy(true);
    try {
      if (stale) throw new Error('The saved answer changed after this draft began. Compare both versions below before saving. Your draft is kept.');
      const raw = value.value ?? '';
      let answer: unknown = raw;
      if (type === 'number') {
        if (!raw.trim()) throw new Error('Enter a number, or choose unknown / not supplied.');
        answer = Number(raw.replace(',', '.'));
        if (!Number.isFinite(answer)) throw new Error('Enter a valid number.');
      } else if (type === 'boolean') {
        if (!['yes', 'no', 'true', 'false'].includes(raw)) throw new Error('Choose Yes or No.');
        answer = raw === 'yes' || raw === 'true';
      } else if (type === 'list') {
        answer = raw.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
        if (!(answer as string[]).length) throw new Error('Add at least one value, or choose unknown / not supplied.');
      } else if (type === 'json') {
        try { answer = JSON.parse(raw); } catch { throw new Error('The structured value is not valid JSON. Keep its original structure or ask your adviser.'); }
      } else if (type === 'null') answer = null;
      const data = {
        farm_id: farmId, key: value.key || String(value.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'manual_answer',
        label: value.label, value: answer, unit: value.unit || null, period: value.period || null, temporal_basis: value.temporal_basis,
        sources: previous ? [...(previous.data.sources || []), { kind: 'correction', record_id: previous.id, revision: baseRevision, note: value.note }] : [{ kind: 'manual', note: value.note }],
        review_status: 'proposed', ...(previous?.data.review_status === 'confirmed' ? { supersedes_id: previous.id } : {}),
      };
      if (previous?.data.review_status === 'proposed') await api.patch(`/facts/${previous.id}`, { expected_revision: baseRevision, data });
      else await api.post('/facts', { data });
      await draft.clear(); await reload(); setSuccess(true);
    } catch (cause) { setError(cause); } finally { setBusy(false); }
  }
  if (!canReview) return <p className="muted">You have read access to these answers. Ask the farm owner for review permission to make changes.</p>;
  return <form className="stack" onSubmit={submit}><Failure error={error}/>{success && <Notice kind="success">Proposed answer saved. Check and confirm it before using it.</Notice>}{draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {draft.ready && stale && <Notice kind="warning"><p>The saved answer changed, or this older draft has no recorded starting version. Your entries are kept below.</p>
      <p>Latest saved answer: <strong>{typeof original === 'boolean' ? original ? 'Yes' : 'No' : show(original)}</strong> {previous?.data.unit || ''} · {previous?.data.period || 'Standing detail'} · revision {previous?.revision}</p>
      <label className="check-row"><input type="checkbox" checked={compared} onChange={event => setCompared(event.target.checked)}/>I compared my draft with the latest saved answer.</label>
      <div className="actions"><Button variant="secondary" disabled={busy || !compared} onClick={() => set('base_revision', String(previous!.revision))}>Keep my changes after comparing</Button><Button variant="ghost" disabled={busy} onClick={() => draft.setValue(startingValue)}>Start from the latest saved answer</Button></div>
    </Notice>}
    <fieldset className="draft-fields" disabled={!draft.ready || busy}><div className="form-grid">
      <Field label="What does this describe?"><input name="label" value={value.label ?? ''} onChange={event => set('label', event.target.value)} required placeholder="For example, total farm area"/></Field>
      <details><summary>Reference used on a form (optional)</summary><Field label="Answer reference"><input name="key" value={value.key ?? ''} onChange={event => set('key', event.target.value)} placeholder="Leave blank if you do not have a form reference"/></Field></details>
      <Field label="Kind of value"><select name="value_type" value={type} onChange={event => set('value_type', event.target.value)}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes or no</option><option value="list">A list of values</option><option value="null">Unknown / not supplied</option><option value="json">Structured data (advanced)</option></select></Field>
      <Field label="Value">{type === 'boolean' ? <select name="value" value={value.value === 'true' ? 'yes' : value.value === 'false' ? 'no' : value.value ?? ''} onChange={event => set('value', event.target.value)} required><option value="">Choose Yes or No</option><option value="yes">Yes</option><option value="no">No</option></select>
        : ['list', 'json'].includes(type) ? <textarea name="value" value={value.value ?? ''} onChange={event => set('value', event.target.value)} required rows={4}/>
        : <input name="value" value={type === 'null' ? '' : value.value ?? ''} onChange={event => set('value', event.target.value)} disabled={type === 'null'}/>}</Field>
      {type === 'list' && <p>Write one value on each line. Keep names or codes exactly as recorded.</p>}
      {type === 'json' && <p>Keep the original JSON structure. For farm activity questions, use <Link to={`/app/checks?farm_id=${farmId}`}>the guided farm checks</Link> instead.</p>}
      <Field label="Unit (if relevant)"><input name="unit" value={value.unit ?? ''} onChange={event => set('unit', event.target.value)} placeholder="For example, ha or kg"/></Field>
      <Field label="Does this belong to a year or a date?"><select name="temporal_basis" value={value.temporal_basis || 'static'} onChange={event => set('temporal_basis', event.target.value)}><option value="static">A standing detail, not a yearly observation</option><option value="campaign_year">Campaign year</option><option value="calendar_date">Exact date</option></select></Field>
      <Field label="Year or date (if relevant)"><input name="period" value={value.period ?? ''} onChange={event => set('period', event.target.value)} placeholder="2026 or 2026-10-16"/></Field>
      <Field label="Where did you check this?"><input name="note" value={value.note ?? ''} onChange={event => set('note', event.target.value)} required placeholder="Source or reason for the correction"/></Field>
    </div><Button type="submit" disabled={stale} loading={busy}>{previous?.data.review_status === 'confirmed' ? 'Propose correction' : previous ? 'Save proposed answer' : 'Save for review'}</Button></fieldset>
    {!draft.ready && <Notice>Opening your private draft…</Notice>}{draft.saving && <p role="status" className="muted">Saving draft on this device…</p>}
  </form>;
}

function FactReview({ fact, reload }: { fact: RecordItem; reload: () => Promise<void> }) {
  const canReview = useReviewAccess();
  const [note,setNote] = useState(''); const [error,setError] = useState<unknown>(null); const [busy,setBusy] = useState(false); const [dependencies,setDependencies] = useState<unknown>(null);
  async function review(decision: string) { setBusy(true); setError(null); try { await api.post(`/facts/${fact.id}/review`,{expected_revision:fact.revision,decision,note}); await reload(); } catch(e) {setError(e);} finally {setBusy(false);} }
  return <article className="panel stack"><div className="actions"><h3>{fact.data.label || fact.data.key}</h3><span className="badge">{fact.data.review_status || 'Not reviewed'}</span></div><p><strong>{show(fact.data.value)}</strong> {fact.data.unit || ''}{fact.data.period ? ` · ${fact.data.period}` : ''}</p><details><summary>Source and history</summary><p>Time basis: {String(fact.data.temporal_basis || 'Not recorded').replaceAll('_',' ')}. Saved {new Date(fact.updated_at).toLocaleString()}.</p><pre>{JSON.stringify(fact.data.sources || [],null,2)}</pre><p>Reference: {fact.data.key}. Revision {fact.revision}.</p><Button variant="secondary" onClick={async () => { try { setDependencies(await api.get(`/facts/${fact.id}/reports`)); } catch(e) {setError(e);} }}>Check reports using this answer</Button>{dependencies !== null && <pre>{JSON.stringify(dependencies,null,2)}</pre>}</details><Failure error={error}/>{error instanceof ApiError && error.status === 409 && <Button variant="secondary" onClick={() => void reload()}>Reload the saved answers before checking again</Button>}{canReview && fact.data.review_status === 'proposed' && <><Field label="Review note"><input value={note} onChange={e => setNote(e.target.value)} placeholder="What did you check?"/></Field><div className="actions"><Button loading={busy} onClick={() => void review('confirmed')}>I checked this — confirm answer</Button><Button variant="secondary" loading={busy} onClick={() => void review('rejected')}>Reject proposal</Button></div></>}{canReview && fact.data.review_status === 'proposed' && <details><summary>Edit this proposal</summary><FactForm farmId={fact.data.farm_id} previous={fact} reload={reload}/></details>}{canReview && fact.data.review_status === 'confirmed' && <details><summary>Propose a correction</summary><p>The checked answer and earlier reports remain in history. The new value needs its own review.</p><FactForm farmId={fact.data.farm_id} previous={fact} reload={reload}/></details>}</article>;
}

function FactConflicts({ farmId, version }: { farmId: string; version: string }) {
  const canReview = useReviewAccess();
  const conflicts = useRecords(`reconciliation?farm_id=${encodeURIComponent(farmId)}`);
  const previousVersion = useRef(version);
  useEffect(() => {
    if (previousVersion.current === version) return;
    previousVersion.current = version;
    void conflicts.reload();
  }, [version, conflicts.reload]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return <>{conflicts.error && <Notice kind="error">Source comparisons could not be loaded: {conflicts.error}</Notice>}<Failure error={error}/>{conflicts.items.map(conflict => <article className="panel" key={`${conflict.id}-${conflict.revision}`}><h3>Different sources for {conflict.data.key}</h3><p>{conflict.data.period || 'Standing farm detail'} · {conflict.data.status === 'resolved' ? 'Choice recorded' : 'Needs your review'}</p>{conflict.data.status === 'resolved' ? <p>{conflict.data.resolution?.data.note}</p> : !canReview ? <p className="muted">Review permission is needed to resolve these sources.</p> : <form className="stack" onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError(null); try { await api.post(`/reconciliation/${conflict.id}/resolve`, {farm_id:farmId,expected_revision:conflict.revision,chosen_fact_id:f.get('chosen'),note:f.get('note')}); await conflicts.reload(); } catch(e) {setError(e);} finally {setBusy(false);} }}><fieldset><legend>Which checked source should be used?</legend>{(conflict.data.candidates || []).map((f: RecordItem) => <label className="field" key={f.id}><span><input type="radio" name="chosen" value={f.id} required/> {show(f.data.value)} {f.data.unit || ''}</span><details><summary>Show source</summary><pre>{JSON.stringify(f.data.sources || [],null,2)}</pre></details></label>)}</fieldset><Field label="Why is this the right source?"><textarea name="note" required/></Field><div><Button type="submit" loading={busy}>Record my choice</Button></div></form>}</article>)}</>;
}
