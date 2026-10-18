import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader, WhoDecides } from '../components';
import type { RecordItem } from '../types';
import type { FieldGeometry, FieldPoint } from './FieldsMap';
import { ParcelMap, isDisplayableFieldGeometry } from '../maps/ParcelMap';
import { resolveSpanishDemo, spanishDemoArea, type SpanishDemoSnapshot } from '../maps/spanishDemo';
import { resolveCommunityReference, resolveDutchReference } from '../maps/outlineReferences';
import { SpanishParcelDemo } from './SpanishParcelDemo';
import './parcelCheck.css';

type Source = { title?: string; url?: string; version?: string | null; article?: string | null; review_note?: string | null };
type ClaimSource = { document_id: string | null; document_revision: number | null; current_revision: number | null; sha256: string | null; name: string; href: string | null; status: 'current' | 'stale' | 'unavailable' | 'unpinned' };
type ClaimContext = {
  declared: number | null; max: number | null; coefficient: number | null; excess: number | null; proposed_claim: number | null;
  proposed_claim_is_draft: boolean;
  status: 'unknown' | 'unconfirmed' | 'confirmed' | 'needs_review'; sources: ClaimSource[];
  fact_ids: string[]; revisions: Record<string, number>; notice: string; review_href: string; problems?: string[];
};
type FieldSummary = {
  id: string; name: string; crop: string | null; external_id: string | null; identity_supplied: boolean;
  geometry_status: 'missing' | 'invalid' | 'valid'; outline_area_ha: number | null; farmer_reported_area_ha: number | null;
  claimed_area_ha: number | null; eligible_area_ha: number | null; eligible_area_basis?: 'user_supplied_maximum_not_certified'; natura_status: 'unknown'; editor_href: string; check_href: string;
  claim_context?: ClaimContext;
};
type Issue = { id: string; field_id: string | null; field_name: string | null; code: string; severity: string;
  title: string; explanation: string; observed: unknown; declared: unknown; unit: string | null;
  sources: Source[]; who_decides: string; action_href: string };
type Check = {
  farm_id: string; farm_revision: number; reporting_year: number; case_id?: string | null; case_revision?: number | null;
  fingerprint: string; rule_hash: string; field_count: number; issue_total: number; limit: number; offset: number; has_more: boolean;
  fields: FieldSummary[]; issues: Issue[]; status: 'review_needed' | 'technical_checks_complete'; notice: string;
  editor_href: string; check_href: string; prepare_href: string; limits?: string[]; sources?: Source[];
};
type Parcel = { id: string; name: string; external_id?: string | null; geometry?: FieldGeometry | null; point?: FieldPoint | null; active?: boolean; [key: string]: unknown };
type Pins = { farm: number; year: number; case?: number };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const positive = (value: string | null) => value !== null && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
const text = (value: unknown): string => value === null || value === undefined ? 'Not recorded' : typeof value === 'string' ? value || 'Left blank' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : Array.isArray(value) ? value.map(text).join('; ') : typeof value === 'object' ? Object.entries(value).map(([key, item]) => `${key.replaceAll('_', ' ')}: ${text(item)}`).join('; ') : String(value);
const validSource = (value: Source) => !!value && ['title', 'url', 'version', 'article', 'review_note'].every(key => typeof value[key as keyof Source] === 'string');
const numberOrNull = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value);
const revisionOrNull = (value: unknown) => value === null || typeof value === 'number' && Number.isInteger(value) && value > 0;
const noMapEdit = () => { /* Read-only map; no draft or save callbacks. */ };
// Padding a decimal place does not round or recalculate the supplied value.
const areaText = (value: number | null) => {
  if (value === null) return 'Not established';
  const raw = String(value);
  if (/e/i.test(raw)) return `${raw} ha`;
  const places = raw.split('.')[1]?.length ?? 0;
  return `${places === 0 ? `${raw}.00` : places === 1 ? `${raw}0` : raw} ha`;
};

function validClaimContext(context: ClaimContext, farmId: string) {
  return !!context && ['unknown', 'unconfirmed', 'confirmed', 'needs_review'].includes(context.status)
    && [context.declared, context.max, context.coefficient, context.excess, context.proposed_claim].every(numberOrNull)
    && typeof context.proposed_claim_is_draft === 'boolean'
    && context.proposed_claim_is_draft === (context.proposed_claim !== null)
    && typeof context.notice === 'string' && appPath(context.review_href, farmId) === `/app/fields/${farmId}#facts`
    && Array.isArray(context.fact_ids) && context.fact_ids.every(id => typeof id === 'string' && uuid.test(id))
    && !!context.revisions && typeof context.revisions === 'object' && !Array.isArray(context.revisions)
    && context.fact_ids.every(id => Number.isInteger(context.revisions[id]) && context.revisions[id] > 0)
    && (context.problems === undefined || Array.isArray(context.problems) && context.problems.every(problem => typeof problem === 'string'))
    && Array.isArray(context.sources) && context.sources.every(source => !!source
      && (typeof source.document_id === 'string' && uuid.test(source.document_id)
        || source.document_id === null && source.status === 'unavailable' && source.document_revision === null && source.current_revision === null && source.sha256 === null && source.href === null)
      && revisionOrNull(source.document_revision) && revisionOrNull(source.current_revision) && (source.sha256 === null || typeof source.sha256 === 'string')
      && typeof source.name === 'string' && (source.href === null || typeof source.href === 'string') && ['current', 'stale', 'unavailable', 'unpinned'].includes(source.status));
}

function ClaimComparison({ context, farmId, year, caseId, realSource }: { context: ClaimContext; farmId: string; year: number; caseId?: string | null; realSource?: SpanishDemoSnapshot | null }) {
  const proposed = context.status === 'unconfirmed';
  const uncertain = context.status === 'needs_review' || context.status === 'unknown';
  const correction = caseId ? `/app/cases/${caseId}/correction` : `/app/cases/new?${new URLSearchParams({ farm_id: farmId, job_type: 'correction', reporting_year: String(year), focused: '1' })}`;
  const sourceStatus = { current: 'Current saved document version', stale: 'The document changed after these values were copied', unavailable: 'Original document unavailable', unpinned: 'No exact source version was selected' };
  const showArea = realSource ? spanishDemoArea : areaText;
  return <section className="parcel-claim-comparison" aria-label="Claim area comparison">
    <p className="parcel-claim-status">{proposed ? 'Proposed values — not yet checked' : uncertain ? 'Source values need review' : 'Values checked by a person — not an authority decision'}</p>
    <h3>{uncertain ? 'Which claim values apply to this field?' : realSource ? 'Compare the claim with the published figures' : 'Compare the claim with the supplied maximum'}</h3>
    <dl className="parcel-claim-values"><div className="parcel-claim-saved"><dt>Area in the saved claim</dt><dd>{showArea(context.declared)}</dd></div><div className="parcel-claim-maximum"><dt>{realSource ? 'Published area × pasture coefficient (calculated)' : 'Maximum area supplied by the source'}</dt><dd>{showArea(context.max)}</dd></div><div className="parcel-claim-coefficient"><dt>Pasture coefficient supplied</dt><dd>{context.coefficient === null ? 'Not established' : `${context.coefficient}%`}</dd></div><div className="parcel-claim-excess"><dt>{realSource ? 'Claim above the calculated comparison' : 'Claim above the supplied maximum'}</dt><dd>{showArea(context.excess)}</dd></div>{context.proposed_claim !== null && <div className="parcel-claim-draft"><dt>Proposed corrected claim — not sent</dt><dd>{showArea(context.proposed_claim)}</dd></div>}</dl>
    {realSource && <p>Area × coefficient is a calculation, not a final eligible-area decision.</p>}
    {proposed && <p>Check these proposed values against the original before using them.</p>}
    {uncertain && <p>Some values are missing, conflicting or no longer tied to a current source. No latest value has been chosen for you. Check which original applies to this field and year.</p>}
    <p className="parcel-claim-no-cut">These figures do not change your outline.</p>
    <Link className="button button-primary" to={appPath(context.review_href, farmId)!}>{context.status === 'confirmed' ? 'See the checked claim values' : 'Review the saved claim values'}</Link>
    <p className="parcel-claim-next">After checking the values, <Link to={correction}>open the guided correction</Link>. Any actual sending remains a separate step.</p>
    <details><summary>Original sources and limits of this comparison</summary>{realSource && <><p>Original published precision: area {realSource.field.area_ha} ha; coefficient {realSource.field.csp_percent}%. Source retrieval: {realSource.retrieved_at}. Campaign year in that service: {realSource.source.campaign_year ?? 'not established'}.</p><p>Unrounded saved values: claim {text(context.declared)} ha; calculated comparison {text(context.max)} ha; difference {text(context.excess)} ha; proposed correction {text(context.proposed_claim)} ha. Two-decimal display does not change the saved numbers.</p></>}<p>{context.notice}</p><p>A pasture coefficient does not identify a contiguous part of the field. A proposed corrected claim does not replace the saved claim or resize its boundary.</p>{context.problems && <ul>{context.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>}{context.sources.length ? <ul>{context.sources.map((source, index) => <li key={`${source.document_id}:${index}`}><strong>{source.name || 'Original document'}</strong><p>{sourceStatus[source.status]}{source.document_revision !== null ? ` · selected version ${source.document_revision}` : ''}{source.current_revision !== null ? ` · current version ${source.current_revision}` : ''}.</p>{source.document_id !== null && source.href === `/app/documents/${source.document_id}` && <Link to={source.href}>Open the original document</Link>}</li>)}</ul> : <p>No original document is available for this comparison.</p>}<p>The supplied maximum is not a new eligibility certification. The responsible authority decides the actual claim and eligible area under the applicable rules.</p></details>
  </section>;
}

function appPath(value: string | undefined, farmId: string): string | null {
  if (!value || !value.startsWith('/app/') || /[\\\u0000-\u0020]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://farm.invalid');
    if (url.origin !== 'https://farm.invalid') return null;
    const fieldRoute = /^\/app\/fields\/([^/]+)(?:\/check)?$/.exec(url.pathname);
    if (fieldRoute && fieldRoute[1] !== farmId) return null;
    const selectedFarm = url.searchParams.get('farm_id');
    if (selectedFarm !== null && selectedFarm !== farmId) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

function SourceDetails({ sources }: { sources: Source[] }) {
  return <>{sources.length ? <ul>{sources.map((source, index) => {
    let href: string | null = null;
    try { const url = new URL(source.url || ''); if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) href = url.href; } catch { /* No unsafe source link. */ }
    return <li key={index}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{source.title || 'Read the source'} (opens a new tab)</a> : <span>{source.title || 'Source link not supplied'}</span>}{source.article && <p>Article or section: {source.article}</p>}{source.version && <p>Source edition: {source.version}</p>}{source.review_note && <p>{source.review_note}</p>}</li>;
  })}</ul> : <p>No specific source article is attached to this check. Ask the recipient or your adviser which requirements apply.</p>}</>;
}

function checkedResult(value: Check, farm: RecordItem, pins: Pins, caseId: string | null, offset: number): Check {
  if (!value || value.farm_id !== farm.id || value.farm_revision !== pins.farm || value.reporting_year !== pins.year
    || (value.case_id ?? null) !== caseId || caseId && value.case_revision !== pins.case
    || !/^[a-f0-9]{64}$/i.test(value.fingerprint) || !/^[a-f0-9]{64}$/i.test(value.rule_hash)
    || !Array.isArray(value.fields) || !Array.isArray(value.issues) || value.issues.length > 8 || value.offset !== offset
    || !Number.isInteger(value.field_count) || value.field_count < 0 || !Number.isInteger(value.issue_total) || value.issue_total < 0
    || value.fields.length !== value.field_count || value.field_count > 2000 || typeof value.has_more !== 'boolean' || value.limit !== 8
    || value.issues.length > Math.max(0, value.issue_total - value.offset) || value.has_more !== (value.offset + value.limit < value.issue_total)
    || (value.status === 'technical_checks_complete') !== (value.issue_total === 0)
    || !Array.isArray(value.limits) || value.limits.some(limit => typeof limit !== 'string') || !Array.isArray(value.sources) || value.sources.some(source => !validSource(source))
    || !['review_needed', 'technical_checks_complete'].includes(value.status) || typeof value.notice !== 'string'
    || value.fields.some(field => !field || typeof field.id !== 'string' || typeof field.name !== 'string'
      || !['missing', 'invalid', 'valid'].includes(field.geometry_status)
      || !numberOrNull(field.claimed_area_ha) || !numberOrNull(field.eligible_area_ha) || field.natura_status !== 'unknown'
      || field.claim_context !== undefined && !validClaimContext(field.claim_context, farm.id)
      || field.claimed_area_ha !== null && (!field.claim_context || field.claim_context.declared !== field.claimed_area_ha)
      || field.eligible_area_ha !== null && (!field.claim_context || field.claim_context.max !== field.eligible_area_ha || field.eligible_area_basis !== 'user_supplied_maximum_not_certified')
      || !(field.outline_area_ha === null || typeof field.outline_area_ha === 'number' && Number.isFinite(field.outline_area_ha))
      || !(field.farmer_reported_area_ha === null || typeof field.farmer_reported_area_ha === 'number' && Number.isFinite(field.farmer_reported_area_ha)))
    || value.issues.some(issue => !issue || typeof issue.id !== 'string' || typeof issue.title !== 'string' || typeof issue.explanation !== 'string'
      || typeof issue.who_decides !== 'string' || !Array.isArray(issue.sources) || issue.sources.some(source => !validSource(source)))
    || !appPath(value.prepare_href, farm.id) || !appPath(value.editor_href, farm.id)) {
    throw new Error('These checks do not match the selected saved farm, year or case. Reload the saved versions before relying on them.');
  }
  const prepare = new URL(value.prepare_href, 'https://farm.invalid');
  if (caseId ? prepare.pathname !== `/app/cases/${caseId}` : prepare.pathname !== '/app/cases/new' || prepare.searchParams.get('farm_id') !== farm.id || prepare.searchParams.get('job_type') !== 'fields' || prepare.searchParams.get('reporting_year') !== String(pins.year)) {
    throw new Error('The preparation link does not match this farm, year or selected case. Reopen the check from the saved record.');
  }
  return value;
}

function FarmParcelCheck({ farmId, workspaceId, query }: { farmId: string; workspaceId: string; query: URLSearchParams }) {
  const [, setParams] = useSearchParams();
  const caseId = query.get('case_id');
  const [stage, setStage] = useState(0); const [attempt, setAttempt] = useState(0); const [offset, setOffset] = useState(0);
  const [fieldChoice, setFieldChoice] = useState<number | null>(null); const [issueId, setIssueId] = useState('');
  const [bundle, setBundle] = useState<{ farm: RecordItem; check: Check } | null>(null);
  const [error, setError] = useState(''); const [stale, setStale] = useState(false); const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const pins = useRef<Pins | null>(null); const request = useRef<AbortController | null>(null); const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    let active = true; setLoading(true); setError(''); setStale(false); setBundle(null);
    async function load() {
      const farm = await (await api.downloadResponse(`/farms/${farmId}`, { signal: controller.signal })).json() as RecordItem;
      if (!active || controller.signal.aborted) return;
      if (farm.id !== farmId || farm.kind !== 'farms' || farm.workspace_id !== workspaceId || !Number.isInteger(farm.revision)) throw new Error('The saved farm could not be verified. Open it again from My fields.');
      if (!pins.current) {
        const year = query.get('reporting_year') ?? String(farm.data.reporting_year ?? '');
        if (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > 2200) throw new Error('The farm needs a reporting year. Save the actual year in its farm details, then reopen this check.');
        pins.current = { farm: query.has('expected_farm_revision') ? Number(query.get('expected_farm_revision')) : farm.revision, year: Number(year), ...(caseId ? { case: Number(query.get('expected_case_revision')) } : {}) };
      }
      const selected = pins.current;
      const params = new URLSearchParams({ expected_farm_revision: String(selected.farm), reporting_year: String(selected.year), limit: '8', offset: String(offset) });
      if (caseId) { params.set('case_id', caseId); params.set('expected_case_revision', String(selected.case)); }
      const data = await (await api.downloadResponse(`/farms/${farmId}/parcel-check?${params}`, { signal: controller.signal })).json() as Check;
      const check = checkedResult(data, farm, selected, caseId, offset);
      if (farm.revision !== selected.farm) throw new Error('The farm changed while these checks were opening. Reload its current saved version.');
      if (active && !controller.signal.aborted) setBundle({ farm, check });
    }
    void load().catch(reason => { if (active && !controller.signal.aborted) { setError(errorMessage(reason)); setStale(reason instanceof ApiError && reason.status === 409); } }).finally(() => { if (active && !controller.signal.aborted) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [farmId, attempt, offset, caseId]);

  async function useLatest() {
    if (reloading) return;
    setReloading(true); setError(''); setBundle(null);
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    try {
      const farm = await (await api.downloadResponse(`/farms/${farmId}`, { signal: controller.signal })).json() as RecordItem;
      if (farm.id !== farmId || farm.kind !== 'farms' || farm.workspace_id !== workspaceId || !Number.isInteger(farm.revision)) throw new Error('The current farm could not be verified.');
      const next = new URLSearchParams(query); next.set('expected_farm_revision', String(farm.revision));
      if (selected && uniqueIdentity) next.set('parcel_id', selected.id);
      if (caseId) {
        const record = await (await api.downloadResponse(`/cases/${caseId}`, { signal: controller.signal })).json() as RecordItem;
        if (record.id !== caseId || record.kind !== 'admin_cases' || record.data.farm_id !== farmId || record.workspace_id !== farm.workspace_id || !Number.isInteger(record.revision)) throw new Error('The current case does not belong to this farm. Reopen the check from its original case.');
        next.set('expected_case_revision', String(record.revision));
      }
      if (mounted.current && !controller.signal.aborted) {
        pins.current = null; setOffset(0); setStage(0); setParams(next, { replace: true }); setAttempt(value => value + 1);
      }
    } catch (reason) { if (mounted.current && !controller.signal.aborted) setError(errorMessage(reason)); }
    finally { if (mounted.current) setReloading(false); }
  }

  const check = bundle?.check;
  const requestedFields = check?.fields.filter(field => field.id === query.get('parcel_id')) || [];
  const selectedIndex = fieldChoice !== null && check?.fields[fieldChoice] ? fieldChoice : requestedFields.length === 1 ? check!.fields.indexOf(requestedFields[0]) : 0;
  const selected = check?.fields[selectedIndex];
  const claimContext = selected?.claim_context;
  const hasClaimContext = !!claimContext && (claimContext.fact_ids.length > 0 || claimContext.status === 'needs_review'
    || [claimContext.declared, claimContext.max, claimContext.coefficient, claimContext.excess, claimContext.proposed_claim].some(value => value !== null));
  const parcel = (bundle?.farm.data.parcels as Parcel[] | undefined)?.filter(field => field && field.active !== false)[selectedIndex];
  const savedParcels = Array.isArray(bundle?.farm.data.parcels) ? bundle.farm.data.parcels as Parcel[] : [];
  const spanishSnapshot = bundle && parcel ? resolveSpanishDemo(bundle.farm, parcel) : null;
  const contextOutlines = (check?.fields ?? []).flatMap(field => {
    if (field.id === selected?.id || !field.identity_supplied || field.geometry_status !== 'valid'
      || check?.fields.filter(other => other.id === field.id).length !== 1) return [];
    const matches = savedParcels.filter(saved => saved && saved.active !== false && saved.id === field.id);
    return matches.length === 1 && isDisplayableFieldGeometry(matches[0].geometry)
      ? [{ id: field.id, label: field.name, geometry: matches[0].geometry }] : [];
  });
  const uniqueIdentity = selected?.identity_supplied && check?.fields.filter(field => field.id === selected.id).length === 1;
  const issue = check?.issues.find(item => item.id === issueId) ?? check?.issues[0];
  const editorHref = appPath(selected?.editor_href || check?.editor_href, farmId) || `/app/fields/${farmId}#boundaries-${farmId}`;
  const editorQuery = new URL(editorHref, 'https://farm.invalid');
  if (selected && uniqueIdentity) editorQuery.searchParams.set('parcel_id', selected.id);
  if (check) {
    editorQuery.searchParams.set('expected_farm_revision', String(check.farm_revision));
    editorQuery.searchParams.set('reporting_year', String(check.reporting_year));
    if (check.case_id) { editorQuery.searchParams.set('case_id', check.case_id); editorQuery.searchParams.set('expected_case_revision', String(check.case_revision)); }
  }
  const fieldEditor = `${editorQuery.pathname}${editorQuery.search}${editorQuery.hash}`;
  const issueEditor = issue && appPath(issue.action_href, farmId) ? new URL(issue.action_href, 'https://farm.invalid') : null;
  if (issueEditor && check) {
    issueEditor.searchParams.set('expected_farm_revision', String(check.farm_revision));
    issueEditor.searchParams.set('reporting_year', String(check.reporting_year));
    if (issue?.field_id && check.fields.filter(field => field.id === issue.field_id && field.identity_supplied).length === 1) issueEditor.searchParams.set('parcel_id', issue.field_id);
    if (check.case_id) { issueEditor.searchParams.set('case_id', check.case_id); issueEditor.searchParams.set('expected_case_revision', String(check.case_revision)); }
  }
  return <div className="parcel-check">
    <PageHeader title="Check your fields" description={bundle ? `${text(bundle.farm.data.name)} · ${check?.reporting_year}` : 'Compare your saved fields before preparing the next step.'} />
    <Link to={`/app/fields/${farmId}`}>Back to this farm</Link>
    <nav aria-label="Field check stages"><ol className="parcel-check-steps">{['Fields and map', 'Things to check', 'Prepare the next step'].map((label, index) => <li key={label}><button type="button" aria-label={label} aria-current={stage === index ? 'step' : undefined} disabled={!check} onClick={() => setStage(index)}><span aria-hidden="true">{index + 1}</span>{label}</button></li>)}</ol></nav>
    {loading && <p role="status">Reading the saved fields and their current checks…</p>}
    {error && <Notice kind="error">{error}<p>No current result is available. An unavailable check is not a completed check.</p><div className="actions">{stale ? <Button loading={reloading} onClick={() => void useLatest()}>Load current farm and case versions</Button> : <Button onClick={() => setAttempt(value => value + 1)}>Try the check again</Button>}</div></Notice>}
    {check && bundle && <>
      <div className="parcel-check-caption"><Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Check again</Button></div>
      {stage === 0 && <section className={`paper-section parcel-check-main${spanishSnapshot ? ' parcel-check-real' : ''}`}><h2>Are these the fields you meant?</h2>
        {query.has('parcel_id') && requestedFields.length !== 1 && <Notice kind="warning">The linked field does not identify one current saved record. Choose the field below; no record has been guessed from a repeated name or identity.</Notice>}
        {selected ? <>
          <Field label="Field to look at"><select value={String(selectedIndex)} onChange={event => setFieldChoice(Number(event.target.value))}>{check.fields.map((field, index) => <option key={index} value={String(index)}>{field.name}</option>)}</select></Field>
          <div className="parcel-check-map-details">
            <div className="parcel-check-map-panel">
              <p className="parcel-check-map-source"><span>{spanishSnapshot ? 'Demo · real SIGPAC references' : 'Saved farm coordinates'}</span><span>{spanishSnapshot ? 'Reference in green · your outline in orange' : `Selected field in green${contextOutlines.length ? ' · other fields in blue' : ''}`}</span></p>
              <ParcelMap key={`${bundle.farm.id}:${bundle.farm.revision}:${selectedIndex}`} readOnly
                geometry={selected.geometry_status === 'valid' ? parcel?.geometry ?? null : null} point={parcel?.point}
                snapshot={spanishSnapshot ? { id: spanishSnapshot.id, reference: spanishSnapshot.field.reference } : null}
                communityReference={resolveCommunityReference(bundle.farm, parcel)}
                dutchReference={resolveDutchReference(bundle.farm, parcel)}
                contextOutlines={contextOutlines} reference={null} sketch={[]} splitLine={[]} mode="edit" onGeometry={noMapEdit} onSketch={noMapEdit} onSplitLine={noMapEdit}
                country={typeof bundle.farm.data.country === 'string' ? bundle.farm.data.country : null}
                region={typeof bundle.farm.data.region === 'string' ? bundle.farm.data.region : null} />
              {hasClaimContext && <p className="parcel-claim-outline"><span>Area inside your drawing, about</span><strong>{areaText(selected.outline_area_ha)}</strong></p>}
              {selected.geometry_status !== 'valid' && <p>{selected.geometry_status === 'invalid' ? 'The saved outline needs repair before it can be shown.' : parcel?.point ? 'Only a supplied location is recorded, not a field boundary.' : 'No field outline or location is saved. The map starts with a general overview, not this field’s location.'}</p>}
              <details><summary>About the map and its sources</summary><p>{spanishSnapshot ? 'The SIGPAC reference and cached PNOA photograph are retained public sources for this demo. They do not establish ownership or current campaign eligibility.' : 'The outline or location comes from your saved farm records. The neutral grid is not a photograph; optional backgrounds have their own source and privacy notice.'}</p><p>Outline area is approximate and separate from claim figures. A coefficient never resizes the field on this page.</p></details>
              {spanishSnapshot && parcel && <SpanishParcelDemo key={`${bundle.farm.id}:${bundle.farm.revision}:${parcel.id}`} farm={bundle.farm} parcel={parcel} onChanged={() => void useLatest()} />}
            </div>
            <div><h3>{selected.name}</h3>
              {hasClaimContext && claimContext && <ClaimComparison context={claimContext} farmId={farmId} year={check.reporting_year} caseId={check.case_id} realSource={spanishSnapshot} />}
              <details open={hasClaimContext ? undefined : true} className="parcel-field-details"><summary>Field details and other area records</summary>
                <dl className="parcel-check-facts"><div><dt>Crop recorded</dt><dd>{selected.crop || 'Not recorded'}</dd></div><div><dt>Field reference recorded</dt><dd>{selected.external_id || 'Not recorded'}</dd></div><div><dt>Area from the outline, approximate</dt><dd>{selected.outline_area_ha === null ? 'Unknown' : `${selected.outline_area_ha} ha`}</dd></div><div><dt>Area reported in your farm records</dt><dd>{selected.farmer_reported_area_ha === null ? 'Not recorded' : `${selected.farmer_reported_area_ha} ha`}</dd></div><div><dt>Area declared in an actual claim</dt><dd>{selected.claimed_area_ha === null ? 'Not established by this check' : `${areaText(selected.claimed_area_ha)} · checked in the app, not authority acceptance`}</dd></div><div><dt>Area eligible for payment</dt><dd>Unknown. The responsible authority decides.</dd></div></dl>
                {!uniqueIdentity && <p>This field needs a unique saved identity before it can be opened directly. Compare the saved fields in the map tools.</p>}
                <Link to={fieldEditor}>{uniqueIdentity ? 'Open this field in the map tools' : 'Open the farm map tools'}</Link>
              </details>
            </div>
          </div>
        </> : <p>No active field is recorded. Add or draw the actual fields before preparing a change.</p>}
        <div className="parcel-check-primary"><Button variant={hasClaimContext ? 'secondary' : 'primary'} onClick={() => setStage(1)}>{check.issue_total ? `Look at ${check.issue_total} ${check.issue_total === 1 ? 'thing' : 'things'} to check` : 'Read the check result'}</Button></div>
      </section>}
      {stage === 1 && <section className="paper-section parcel-check-main"><p className="eyebrow">Check one thing at a time</p><h2>{check.issue_total ? 'Things to check before you continue' : 'No warning was found in these outlines'}</h2><p>{check.issue_total ? `${check.issue_total} ${check.issue_total === 1 ? 'thing needs' : 'things need'} a look across this farm. These checks do not decide which land can be paid for.` : 'This checks the saved outlines only. It does not confirm which rules apply, which land can be paid for or whether an authority will accept a claim.'}</p>
        {issue ? <div className="parcel-check-issues"><nav aria-label="Things to check"><ul>{check.issues.map(item => <li key={item.id}><button type="button" aria-current={item.id === issue.id ? 'true' : undefined} onClick={() => { setIssueId(item.id); const matches = check.fields.filter(field => field.id === item.field_id); if (matches.length === 1) setFieldChoice(check.fields.indexOf(matches[0])); }}><strong>{item.field_name || 'Whole farm'}</strong><span>{item.title}</span></button></li>)}</ul></nav><article className="parcel-check-issue"><h3>{issue.title}</h3><p>{issue.explanation}</p><dl className="parcel-check-facts"><div><dt>Observed in the saved records</dt><dd>{text(issue.observed)}{issue.unit ? ` ${issue.unit}` : ''}</dd></div><div><dt>Declared or supplied for comparison</dt><dd>{text(issue.declared)}{issue.unit ? ` ${issue.unit}` : ''}</dd></div></dl>{issueEditor && <p><Link to={`${issueEditor.pathname}${issueEditor.search}${issueEditor.hash}`}>Open the relevant record or map tools</Link></p>}{issue.who_decides && <p className="who-row">{/\byou\b|adviser/i.test(issue.who_decides) && <WhoDecides who="farmer">You or your adviser review</WhoDecides>}{/paying agency/i.test(issue.who_decides) && <WhoDecides who="agency">Paying agency decides</WhoDecides>}</p>}<details><summary>Source, limits and who decides</summary><p>{issue.who_decides}</p><SourceDetails sources={issue.sources} /></details></article></div> : <p>There is no issue on this page. Read the limits below before deciding what to prepare.</p>}
        {(offset > 0 || check.has_more) && <div className="actions parcel-check-pages"><Button variant="secondary" disabled={offset === 0} onClick={() => { setIssueId(''); setOffset(Math.max(0, offset - 8)); }}>Previous checks</Button><span>Showing {check.issues.length ? offset + 1 : 0} to {offset + check.issues.length} of {check.issue_total}</span><Button variant="secondary" disabled={!check.has_more} onClick={() => { setIssueId(''); setOffset(offset + 8); }}>More checks</Button></div>}
        <div className="parcel-check-primary"><Button onClick={() => setStage(2)}>Choose the next preparation step</Button><Button variant="ghost" onClick={() => setStage(0)}>Back to the fields</Button></div>
      </section>}
      {stage === 2 && <section className="paper-section parcel-check-main"><p className="eyebrow">Keep preparation separate from sending</p><h2>Prepare the next step</h2><p>{check.issue_total ? 'Keep the open points with your field change. Preparing a folder does not resolve them or make a claim eligible.' : 'You can prepare the selected records for a separate human review. This is not an official approval.'}</p><p>Use the map tools to save any actual change, compare the old and proposed fields, then confirm the private change separately. A case keeps the records and next sending steps together.</p><div className="parcel-check-primary"><Link className="button button-primary" to={appPath(check.prepare_href, farmId)!}>{check.case_id ? 'Continue the saved case' : 'Prepare a field-change case'}</Link></div><p><Link to={fieldEditor}>Change or compare a field first</Link></p><p>Nothing on this page changes LPIS, sends an application or records an authority response.</p></section>}
      <details className="parcel-check-limits"><summary>What this check can and cannot tell you</summary><p>Saved farm version {check.farm_revision} · {check.field_count} {check.field_count === 1 ? 'field' : 'fields'}{check.case_id ? ` · case version ${check.case_revision}` : ''}.</p><p>{check.notice}</p>{check.limits && <ul>{check.limits.map((limit, index) => <li key={index}>{limit}</li>)}</ul>}<SourceDetails sources={check.sources || []} /><p className="parcel-check-version">Saved check reference: {check.fingerprint}<br />Rule edition reference: {check.rule_hash}</p></details>
    </>}
  </div>;
}

export function ParcelCheckPage() {
  const { id = '' } = useParams(); const [query] = useSearchParams(); const { session, loading } = useSession();
  if (loading) return <p role="status">Checking your farm access…</p>;
  if (!session) return <Notice kind="error">Sign in to check your fields.</Notice>;
  if (!uuid.test(id) || ['reporting_year', 'expected_farm_revision', 'case_id', 'expected_case_revision', 'parcel_id'].some(key => query.getAll(key).length > 1)
    || query.has('expected_farm_revision') && !positive(query.get('expected_farm_revision'))
    || query.has('expected_case_revision') && !positive(query.get('expected_case_revision'))
    || query.has('case_id') !== query.has('expected_case_revision') || query.has('case_id') && !uuid.test(query.get('case_id') || '')
    || query.has('reporting_year') && (!/^\d{4}$/.test(query.get('reporting_year') || '') || Number(query.get('reporting_year')) < 1900 || Number(query.get('reporting_year')) > 2200)) return <Notice kind="error">This field-check link is incomplete or has an invalid saved version. Open the farm or case and choose its check link again.</Notice>;
  if (Array.isArray(session.workspace.farm_ids) && !session.workspace.farm_ids.includes(id)) return <Notice kind="error">This farm is not available through your current permission.</Notice>;
  const binding = JSON.stringify([session.user.id, session.workspace.id, session.workspace.role, session.workspace.permissions, session.workspace.farm_ids, id, query.toString()]);
  return <FarmParcelCheck key={binding} farmId={id} workspaceId={session.workspace.id} query={query} />;
}
