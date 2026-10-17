import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Notice, PageHeader } from '../components';
import { saveDraft, usePrivateDraft } from '../offline';
import type { RecordItem } from '../types';
import { caseStatusLabel, type CaseStatus } from './case-types';
import { ImportDemo } from './ImportDemo';
import './hackathonDemo.css';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DRAFT = 'examples/hackathon-demo-v1';
type SavedRun = { runId: string; workspaceId: string };
type Saved = { retryKey: string; created: SavedRun | null };
type SavedRecord = { id: string; kind: string; revision: number; label: string; status?: string; farm_id: string | null; alias?: string; scenario_id: string };
type SavedCase = { id: string; revision: number; status: CaseStatus; checks: { next_action: string; can_review: boolean };
  items: { id: string; title: string; status: string }[] };
type Demo = {
  run_id: string; revision: number; fixture_id: string; notice: string; workspace: { id: string; name: string; role: string };
  fixture_record_count: number;
  role: { actual: string; preview: false }; records: SavedRecord[];
  scenarios: { id: string; key: string; title: string; description: string; farmer_goal: string; adviser_goal: string;
    record_ids: string[]; expected_actions: string[]; cases: SavedCase[] }[];
};
type StepId = 'fields' | 'import' | 'checks';
const stepIds: StepId[] = ['fields', 'import', 'checks'];
type Farm = RecordItem<{ name: string; origin?: string; parcels: { id: string; name: string; active?: boolean }[] }>;
type ClaimFact = RecordItem<{ farm_id: string; parcel_id?: string; key: string; value: unknown; unit?: string | null; temporal_basis?: string; period?: string | null }>;
type Guide = { case_id: string; case_revision: number; evaluation: {
  title: string; explanation: string; status: string;
  deadlines: { national: string | null; effective: string | null; eu_latest_possible: string | null; status: string };
  sources: { key: string; title: string; url: string; article?: string; version?: string }[];
} };
const sampleLabel = (value: string) => value.replace(/^FICTIONAL(?:\s+example)?\s*(?:[—–-]\s*)?/i, '');
function sourceHref(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function suppliedNumber(facts: ClaimFact[] | undefined, id: string | undefined, key: string, unit: string) {
  const data = facts?.find(fact => fact.id === id)?.data;
  if (!data || data.key !== key || data.unit !== unit || data.temporal_basis !== 'campaign_year' || data.period !== '2026'
    || typeof data.value !== 'number' || !Number.isFinite(data.value)) return 'Needs checking';
  const raw = String(data.value);
  const displayed = unit === '%' || /e/i.test(raw) ? raw : !raw.includes('.') ? `${raw}.00` : raw.split('.')[1].length === 1 ? `${raw}0` : raw;
  return `${displayed}${unit === '%' ? '%' : ` ${unit}`}`;
}

function checked(value: Demo, workspaceId?: string, runId?: string): Demo {
  if (!value || !UUID.test(value.run_id) || !UUID.test(value.workspace?.id) || value.fixture_id !== 'lpis-correction-2026-v1' ||
      value.role?.preview !== false || value.role.actual !== value.workspace.role || !Array.isArray(value.scenarios) ||
      value.scenarios.length > 7 || !Array.isArray(value.records) || value.records.length > 200 ||
      workspaceId && value.workspace.id !== workspaceId || runId && value.run_id !== runId) {
    throw new Error('The saved demo could not be checked. Your existing farm records have not been changed.');
  }
  return value;
}

export function HackathonDemoPage() {
  const { session } = useSession();
  if (!session) return <Notice>Sign in to try the demo with private sample records.</Notice>;
  return <GuidedDemo key={`${session.user.id}/${session.workspace.id}`} scope={`${session.user.id}/${session.workspace.id}`}
    workspaceId={session.workspace.id} owner={session.workspace.role === 'owner'}/>;
}

function GuidedDemo({ scope, workspaceId, owner }: { scope: string; workspaceId: string; owner: boolean }) {
  const { switchWorkspace } = useSession();
  const [params, setParams] = useSearchParams();
  const [initial] = useState<Saved>(() => ({ retryKey: crypto.randomUUID(), created: null }));
  const draft = usePrivateDraft<Saved>(DRAFT, initial);
  const suppliedRun = params.get('run_id')?.toLowerCase() ?? null;
  const suppliedWorkspace = params.get('workspace_id')?.toLowerCase() ?? null;
  const remembered = draft.ready ? draft.value.created : null;
  const runId = suppliedRun ?? (remembered?.workspaceId === workspaceId ? remembered.runId : null);
  const targetWorkspace = suppliedWorkspace ?? (runId ? workspaceId : null);
  const valid = params.getAll('run_id').length <= 1 && params.getAll('workspace_id').length <= 1 &&
    (suppliedRun === null || UUID.test(suppliedRun)) && (suppliedWorkspace === null || UUID.test(suppliedWorkspace)) &&
    (!suppliedWorkspace || !!suppliedRun) && (!runId || UUID.test(runId));
  const differentWorkspace = !!targetWorkspace && targetWorkspace !== workspaceId;
  const [loaded, setData] = useState<Demo | null>(null);
  const data = valid && !differentWorkspace && loaded?.run_id === runId && loaded.workspace.id === workspaceId ? loaded : null;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);

  useEffect(() => {
    const sequence = ++generation.current;
    const controller = new AbortController();
    setError('');
    if (valid && runId && !differentWorkspace) {
      api.downloadResponse(`/examples/workspace/${runId}`, { signal: controller.signal })
        .then(response => response.json() as Promise<Demo>)
        .then(value => { const saved = checked(value, workspaceId, runId); if (mounted.current && sequence === generation.current) setData(saved); })
        .catch(failure => { if (mounted.current && sequence === generation.current && !controller.signal.aborted) { setData(null); setError(errorMessage(failure)); } });
    }
    return () => controller.abort();
  }, [valid, runId, differentWorkspace, workspaceId, refresh]);

  useEffect(() => {
    if (data && draft.ready && (draft.value.created?.runId !== data.run_id || draft.value.created.workspaceId !== workspaceId)) {
      draft.setValue(previous => ({ ...previous, created: { runId: data.run_id, workspaceId } }));
    }
  }, [data?.run_id, draft.ready, workspaceId]);

  const scenario = data?.scenarios.find(item => item.key === 'es-protected-unknown' || item.id === 'es-protected-unknown');
  const related = data && scenario ? data.records.filter(record => scenario.record_ids.includes(record.id)) : [];
  const farm = related.find(record => record.kind === 'farms');
  const factAliases = ['es-claimed-area', 'es-eligible-area', 'es-coefficient', 'es-corrected-area'];
  const facts = related.filter(record => record.kind === 'facts' && factAliases.includes(record.alias ?? ''));
  const claimFact = facts.find(record => record.alias === 'es-claimed-area');
  const evidenceTask = related.find(record => record.kind === 'tasks' && record.alias === 'es-lease-evidence');
  const savedCase = scenario?.cases.find(item => item.id === related.find(record => record.kind === 'admin_cases')?.id);
  const reviewedFacts = facts.filter(record => record.status === 'confirmed').length;
  const requestedStep = params.get('step');
  const step: StepId = requestedStep && stepIds.includes(requestedStep as StepId) ? requestedStep as StepId
    : requestedStep === 'correction' || requestedStep === 'folder' ? 'checks' : 'fields';
  const contextReady = !!farm && facts.length === 4 && !!savedCase && [farm.id, savedCase.id, ...facts.map(record => record.id)].every(id => UUID.test(id));
  const contextKey = contextReady ? `${data!.run_id}/${farm!.id}/${farm!.revision}/${facts.map(fact => `${fact.id}:${fact.revision}`).join(',')}/${savedCase!.id}/${savedCase!.revision}` : '';
  const [fieldContext, setFieldContext] = useState<{ key: string; farm?: Farm; facts?: ClaimFact[]; parcelId?: string; error?: string }>({ key: '' });
  const [guidance, setGuidance] = useState<{ key: string; guide?: Guide; error?: string }>({ key: '' });
  const currentFields = fieldContext.key === contextKey ? fieldContext : null;
  const currentGuide = guidance.key === contextKey ? guidance : null;
  const activeFields = currentFields?.farm?.data.parcels.filter(parcel => parcel.active !== false);
  const publicParcelDemo = currentFields?.farm?.data.origin === 'sigpac_public_demo_2026_10_17';
  const fieldQuery = new URLSearchParams({ expected_farm_revision: String(farm?.revision ?? ''), reporting_year: '2026' });
  if (savedCase) { fieldQuery.set('case_id', savedCase.id); fieldQuery.set('expected_case_revision', String(savedCase.revision)); }
  if (currentFields?.parcelId) fieldQuery.set('parcel_id', currentFields.parcelId);
  const fieldsHref = farm ? `/app/fields/${farm.id}/check?${fieldQuery}` : '';
  const parcelQuery = new URLSearchParams(fieldQuery);
  if (currentFields?.parcelId) parcelQuery.set('parcel_id', currentFields.parcelId);
  const pastureHref = farm && currentFields?.parcelId ? `/app/fields/${farm.id}?${parcelQuery}#boundaries-${farm.id}` : '';
  const factsHref = farm ? `/app/fields/${farm.id}#facts` : '';
  const caseHref = savedCase ? `/app/cases/${savedCase.id}` : '';
  const steps: { id: StepId; title: string; subtitle: string }[] = [
    { id: 'fields', title: 'Check my fields', subtitle: 'Map, crop and claim' },
    { id: 'import', title: 'Import my records', subtitle: 'Extract, check and save' },
    { id: 'checks', title: 'Before and after filing', subtitle: 'Checks, dates and correction' },
  ];
  const active = steps.find(item => item.id === step)!;

  useEffect(() => {
    if (!contextReady || !farm || !claimFact || !savedCase) return;
    const controller = new AbortController();
    const get = async <T,>(path: string) => (await api.downloadResponse(path, { signal: controller.signal })).json() as Promise<T>;
    void Promise.all([get<Farm>(`/farms/${farm.id}`), Promise.all(facts.map(fact => get<ClaimFact>(`/facts/${fact.id}`)))]).then(([savedFarm, savedFacts]) => {
      if (savedFarm.id !== farm.id || savedFarm.kind !== 'farms' || savedFarm.workspace_id !== workspaceId || savedFarm.revision !== farm.revision
        || !Array.isArray(savedFarm.data.parcels) || savedFarm.data.parcels.length > 2000
        || savedFacts.some((savedFact, index) => savedFact.id !== facts[index].id || savedFact.kind !== 'facts' || savedFact.workspace_id !== workspaceId
          || savedFact.revision !== facts[index].revision || savedFact.data.farm_id !== farm.id)) throw new Error('The farm changed. Refresh the saved demo before opening a particular field.');
      const parcelId = savedFacts.find(fact => fact.id === claimFact.id)?.data.parcel_id;
      const matches = savedFarm.data.parcels.filter(parcel => parcel.active !== false && parcel.id === parcelId);
      if (parcelId && (!UUID.test(parcelId) || matches.length !== 1)) throw new Error('D04’s saved field link needs checking. Open the whole map to review the current fields.');
      if (!controller.signal.aborted) setFieldContext({ key: contextKey, farm: savedFarm, facts: savedFacts, parcelId });
    }).catch(failure => { if (!controller.signal.aborted) setFieldContext({ key: contextKey, error: errorMessage(failure) }); });
    void get<Guide>(`/cases/${savedCase.id}/correction-guide`).then(guide => {
      if (guide.case_id !== savedCase.id || guide.case_revision !== savedCase.revision || !guide.evaluation
        || typeof guide.evaluation.title !== 'string' || typeof guide.evaluation.explanation !== 'string'
        || !guide.evaluation.deadlines || !Array.isArray(guide.evaluation.sources) || guide.evaluation.sources.length > 20
        || guide.evaluation.sources.some(source => !source || typeof source.key !== 'string' || typeof source.title !== 'string' || typeof source.url !== 'string')
        || guide.evaluation.deadlines.effective !== null && !/^\d{4}-\d{2}-\d{2}$/.test(guide.evaluation.deadlines.effective)) throw new Error('The saved date guidance changed. Open the correction to check its current details.');
      if (!controller.signal.aborted) setGuidance({ key: contextKey, guide });
    }).catch(failure => { if (!controller.signal.aborted) setGuidance({ key: contextKey, error: errorMessage(failure) }); });
    return () => controller.abort();
  }, [contextKey, refresh]);

  function chooseStep(id: StepId) {
    const next = new URLSearchParams(params);
    if (data) { next.set('run_id', data.run_id); next.set('workspace_id', data.workspace.id); }
    next.set('step', id); setParams(next, { replace: true });
  }

  async function openRun(run: SavedRun) {
    setParams({ run_id: run.runId, workspace_id: run.workspaceId }, { replace: true });
    try { await switchWorkspace(run.workspaceId); }
    catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
  }

  async function start() {
    if (!owner || !draft.ready || writing.current || runId || !valid) return;
    writing.current = true; setBusy(true); setError('');
    try {
      if (!UUID.test(draft.value.retryKey)) throw new Error('The saved start reference could not be read. No new sample has been requested.');
      await saveDraft(scope, DRAFT, draft.value);
      const result = checked(await api.post<Demo>('/examples/workspace', { fixture_id: 'lpis-correction-2026-v1', acknowledged: true }, { idempotencyKey: draft.value.retryKey }));
      const created = { runId: result.run_id, workspaceId: result.workspace.id };
      await saveDraft(scope, DRAFT, { ...draft.value, created });
      if (!mounted.current) return;
      draft.setValue(previous => ({ ...previous, created }));
      await openRun(created);
    } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { writing.current = false; if (mounted.current) setBusy(false); }
  }

  return <div className="hackathon-demo">
    <PageHeader title="From field to paperwork." description="Compare fields, bring in a record, then work through the checks and any correction."/>
    <p className="hackathon-demo-badge">Demo</p>
    {!valid && <Notice kind="error">This demo link is incomplete. <Link to="/app/demo">Open the demo start page</Link>.</Notice>}
    {error && <Notice kind="error">{error} <Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh the saved demo</Button></Notice>}
    {draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {valid && differentWorkspace && <section className="card stack"><h2>Continue this demo</h2><Button onClick={() => void openRun({ runId: runId!, workspaceId: targetWorkspace! })}>Open demo</Button></section>}
    {valid && !runId && <section className="card hackathon-demo-start"><h2>Three jobs. One connected record.</h2><p>Check the map, bring in a file and prepare the next step. Your own farm stays unchanged.</p>
      {!owner ? <Notice>Ask an owner to start a demo and invite you.</Notice> : <Button loading={busy} disabled={!draft.ready} onClick={() => void start()}>Start demo</Button>}
      {remembered && <Button variant="secondary" onClick={() => void openRun(remembered)}>Continue my saved demo</Button>}
    </section>}
    {valid && runId && !differentWorkspace && !data && !error && <Notice>Opening your saved demo…</Notice>}
    {data && !contextReady && <Notice kind="warning">The Cáceres pasture correction is not available in this saved run. <Link to={`/app/examples?${new URLSearchParams({ run_id: data.run_id, workspace_id: data.workspace.id })}`}>Open the situations available to your account or start a fresh sample</Link>. This saved run has not been replaced.</Notice>}
    {data && contextReady && <>
      <nav className="hackathon-demo-steps" aria-label="Demo chapters">{steps.map((item, index) => <button key={item.id} type="button" className={step === item.id ? 'is-current' : ''} aria-current={step === item.id ? 'step' : undefined} onClick={() => chooseStep(item.id)}><span className="hackathon-demo-step-number" aria-hidden="true">{index + 1}</span><span>{item.title}<small>{item.subtitle}</small></span></button>)}</nav>
      <section className="card hackathon-demo-current" aria-labelledby="hackathon-demo-step-title">
        <p className="eyebrow">Chapter {stepIds.indexOf(step) + 1} of 3</p><h2 id="hackathon-demo-step-title">{active.title}</h2>
        {step === 'fields' && <div className="hackathon-demo-chapter">
          <p>{publicParcelDemo ? 'Compare five Spanish parcels with an aerial photo. The demo starts with three gaps filled in D04’s drawing. Check them against the reference, correct the drawing, then review the change.' : 'Compare the field boundaries and crops. Check the claim figures separately from the drawing.'}</p>
          <p className="hackathon-demo-status">{activeFields ? `${activeFields.length} fields saved` : 'Open the map to see the current fields'} · {reviewedFacts} of {facts.length} claim figures reviewed.</p>
          {currentFields?.farm ? <Link className="button button-primary" to={fieldsHref}>Open the field map and checks</Link> : <Button disabled>Opening the saved field link…</Button>}
          <div className="hackathon-demo-claim"><h3>D04: why does the claim need attention?</h3><dl><div><dt>Saved claim</dt><dd>{suppliedNumber(currentFields?.facts, claimFact?.id, 'cap.claimed_area_ha', 'ha')}</dd></div><div><dt>{publicParcelDemo ? 'Calculated area' : 'Maximum in the source'}</dt><dd>{suppliedNumber(currentFields?.facts, facts.find(fact => fact.alias === 'es-eligible-area')?.id, 'cap.supplied_max_eligible_area_ha', 'ha')}</dd></div><div><dt>Pasture coefficient</dt><dd>{suppliedNumber(currentFields?.facts, facts.find(fact => fact.alias === 'es-coefficient')?.id, 'cap.pasture_coefficient_percent', '%')}</dd></div><div><dt>Proposed corrected claim</dt><dd>{suppliedNumber(currentFields?.facts, facts.find(fact => fact.alias === 'es-corrected-area')?.id, 'cap.proposed_claim_area_ha', 'ha')}</dd></div></dl><p>{publicParcelDemo ? '63.0449 ha × 90% = 56.74041 ha. This is a calculation, not an official maximum.' : 'Check these figures against the original.'} Do not use the percentage to draw a smaller field.</p><div className="hackathon-demo-actions"><Link to={factsHref}>Review D04’s saved figures</Link>{pastureHref && <Link to={pastureHref}>Adjust D04 on the map</Link>}</div></div>
          {currentFields?.error && <Notice kind="warning">{currentFields.error}</Notice>}
          <Link className="hackathon-demo-easy" to={`/app/easy-form?farm_id=${farm!.id}`}>Easy form: fill it in step by step</Link>
          {evidenceTask && <p className="muted">Disagree with the source? <Link to={`/app/tasks/${evidenceTask.id}`}>Check what evidence is needed</Link>.</p>}
        </div>}
        {step === 'import' && <div className="hackathon-demo-chapter"><p>Upload a receipt or table. Check the details the app finds against the original, then save them.</p><ImportDemo farmId={farm!.id} farmName={sampleLabel(farm!.label)}/></div>}
        {step === 'checks' && <div className="hackathon-demo-chapter">
          <p className="hackathon-demo-status"><strong>Case status:</strong> {caseStatusLabel[savedCase!.status] ?? 'Check the current case'}.</p>
          <div className="hackathon-demo-check-jobs"><section><h3>Before you file</h3><p>Check the fields and compare each answer with the original.</p>{currentFields?.farm ? <Link to={fieldsHref}>Run the field checks</Link> : <p>Opening the saved field link…</p>}<Link to={`${caseHref}/correction?step=4`}>Check each answer</Link></section><section><h3>After you filed</h3><p>Keep the original and work through what needs correcting.</p><Link to={`${caseHref}/correction?step=1`}>Work through a correction</Link><Link to={`${caseHref}/correction?step=3`}>Check the dates and conditions</Link></section></div>
          <section className="hackathon-demo-date" aria-label="Saved correction date guidance"><h3>{currentGuide?.guide?.evaluation.deadlines.effective ? `Source-linked date: ${currentGuide.guide.evaluation.deadlines.effective}` : 'Correction date not established'}</h3>{currentGuide?.guide ? <><p>{sampleLabel(currentGuide.guide.evaluation.title)}</p><details><summary>Source and conditions</summary><p>{currentGuide.guide.evaluation.explanation}</p><p>Check that this source and its conditions apply to your case. A saved date is not permission to amend.</p><ul>{currentGuide.guide.evaluation.sources.map(source => { const href = sourceHref(source.url); return <li key={source.key}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{source.title}</a> : source.title}{source.article && <> · {source.article}</>}{source.version && <> · {source.version}</>}</li>; })}</ul></details></> : <p>{currentGuide?.error || 'Open the date questions to see what still needs checking.'}</p>}<Link to={`${caseHref}/correction?step=3`}>Review the date questions</Link></section>
          <details className="hackathon-demo-date" data-testid="demo-historical-deadlines"><summary>Historical deadline: 7 September 2026 · limited E1/E2 monitoring response, now past</summary><p>Extremadura campaign references. Neither is assigned to this case.</p><ul><li><strong><time dateTime="2026-05-15">15 May 2026</time> · ordinary filing · past</strong><p>The listed 2026/2027 Single Application presentation period, not an ordinary amendment deadline. A later exceptional late-filing announcement exists; its operative conditions were not checked here.</p><a href="https://doe.juntaex.es/otrosFormatos/html.php?anio=2026&doe=710o&xml=2026060825" target="_blank" rel="noopener noreferrer">DOE 71, 15 April 2026 · resolution of 8 April</a></li><li><strong><time dateTime="2026-09-07">7 September 2026</time> · limited monitoring response · past</strong><p>E1/E2 yellow/red monitoring incidents only: reason 5 modifications or reason 8 georeferenced-photo documents. Not a blanket amendment, appeal or correction date.</p><a href="https://doe.juntaex.es/otrosFormatos/html.php?anio=2026&doe=1720o&xml=2026081488" target="_blank" rel="noopener noreferrer">DOE 172, 4 September 2026 · announcement of 1 September</a></li></ul><p>The ordinary 2026 amendment date and this case’s matching notice remain unestablished. Select an actual matching notice and its saved source in the date questions before entering a date. A SIGPAC service window is a different procedure.</p><details><summary>Source review limits</summary><p>The full operative HTML acts for May (DOE 71) and September (DOE 172) were read. DOE identifies the linked official PDFs as authoritative; those PDFs were not fetched. These references do not establish applicability to this case or current permission to amend.</p></details></details>
          <Link className="button button-primary" to={`${caseHref}#case-checks`}>Review the case and prepare the folder</Link><p className="muted">Preparing the folder does not send it.</p>
        </div>}
        {step !== 'checks' && <Button variant="ghost" onClick={() => chooseStep(stepIds[stepIds.indexOf(step) + 1])}>Next: {steps[stepIds.indexOf(step) + 1].title.toLowerCase()}</Button>}
      </section>
      <div className="hackathon-demo-bottom"><Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh saved records</Button><Link to={`/app/examples?${new URLSearchParams({ run_id: data.run_id, workspace_id: data.workspace.id })}`}>Try the other farm situations</Link></div>
      <p className="muted">{publicParcelDemo ? 'The parcels are real; the claim and mistake are for practice. The references do not prove ownership.' : 'Sample records for practice.'} Changes here do not update LPIS or send paperwork. <Link to="/app/adviser">Work with an adviser</Link>.</p>
    </>}
  </div>;
}
