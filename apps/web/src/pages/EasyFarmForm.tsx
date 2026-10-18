import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useSession } from '../auth';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { saveDraft, usePrivateDraft } from '../offline';
import { SigpacMap, type MapField } from '../maps/SigpacMap';
import { VoiceButton, cropFromSpeech } from '../voice';
import { BrickWall, Carrot, CircleCheck, Droplets, Flower2, Grape, House, Leaf, Mountain, Send, Sprout, Trees, TreeDeciduous, TriangleAlert, UserRound, Wheat, type LucideIcon } from 'lucide-react';
import { resolveSpanishDemo } from '../maps/spanishDemo';
import type { FieldGeometry, FieldPoint } from './FieldsMap';
import type { RecordItem } from '../types';
import './easyFarmForm.css';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type Decision = '' | 'yes' | 'change' | 'unknown';
type Parcel = { id: string; name: string; crop?: string | null; notes?: string | null; greenhouse?: boolean; external_id?: string | null; geometry?: FieldGeometry | null; point?: FieldPoint | null; approximate_area_ha?: number | null; geometry_summary?: { bbox?: number[] | null; warnings?: string[] } };
type Country = { country: string; name: string; modules: { workflow_id: string; name: string; task?: string; coverage_limit?: string; pack_ids?: string[]; mapping_status?: string }[] };
type Bundle = { farm: RecordItem; fields: Parcel[]; country: Country };
type CropEdit = { crop: string; custom: string; note: string; attempt: string; proposalId?: string; proposalRevision?: number };
type Draft = { version: 1; farmRevision: number; step: number; identity: Decision; fields: Decision; crops: Record<string, Decision>; cropEdits?: Record<string, CropEdit>; features: Decision; featureNote: string; support: Decision };
const titles = ['Is this your farm?', 'Do these fields look right?', 'What is growing here?', 'What else is on the land?', 'Do you need support paperwork?', 'Check your answers'];
const decisionLabel: Record<Decision, string> = { '': 'Not answered', yes: 'You said this is right', change: 'Needs a change', unknown: 'Not sure yet' };
const hasValidOutline = (field: Parcel) => !!field.geometry && Array.isArray(field.geometry_summary?.bbox) && field.geometry_summary.bbox.length === 4 && field.geometry_summary.bbox.every(Number.isFinite);

// Pictures, not words: the crops most often declared, as big tiles. "Other" stays available below.
const cropTiles: [string, LucideIcon][] = [['Wheat or barley', Wheat], ['Maize', Sprout], ['Sunflower', Flower2], ['Grass', Leaf], ['Vines', Grape], ['Vegetables', Carrot]];
const featureTiles: [string, LucideIcon][] = [['Hedge', Trees], ['Tree', TreeDeciduous], ['Pond', Droplets], ['Stone wall', BrickWall]];
const elementIcons: Record<string, LucideIcon> = { AG: Trees, AL: Trees, AP: TreeDeciduous, CH: Droplets, CO: House, IS: Mountain, LD: BrickWall, MU: BrickWall, ST: Trees, TR: Mountain };
type Element = { properties: { kind: string; code: string; name: string; length_m?: number } };

function OfficialElements({ fields, country }: { fields: Parcel[]; country: unknown }) {
  const [items, setItems] = useState<Element[] | null>(null);
  const [error, setError] = useState('');
  const boxes = fields.map(field => field.geometry_summary?.bbox).filter((box): box is number[] => Array.isArray(box) && box.length === 4);
  const bbox = boxes.length ? [Math.min(...boxes.map(b => b[0])) - .001, Math.min(...boxes.map(b => b[1])) - .001, Math.max(...boxes.map(b => b[2])) + .001, Math.max(...boxes.map(b => b[3])) + .001] : null;
  const usable = country === 'ES' && bbox && (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) <= .0025;
  useEffect(() => {
    if (!usable || !bbox) return;
    let active = true;
    api.get<{ features: Element[] }>(`/sigpac/elementos?bbox=${bbox.map(value => value.toFixed(5)).join(',')}`)
      .then(result => { if (active) setItems(result.features); }).catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [usable, bbox?.join()]);
  if (!usable) return null;
  const groups = new Map<string, { name: string; count: number; length: number }>();
  for (const item of items ?? []) {
    const key = `${item.properties.kind}:${item.properties.code}`;
    const entry = groups.get(key) ?? { name: item.properties.name, count: 0, length: 0 };
    entry.count += 1; entry.length += item.properties.length_m ?? 0; groups.set(key, entry);
  }
  return <section className="easy-card" aria-label="Landscape elements on the official map">
    <span className="easy-source">From SIGPAC (FEGA)</span>
    {error ? <p>{error}</p> : !items ? <p>Reading the official map…</p> : !items.length ? <p>The official map shows no landscape elements on or next to these fields.</p> : <>
      <p>The official map shows these next to your fields. Is it right?</p>
      <ul className="easy-tiles is-readonly">{[...groups].map(([key, entry]) => { const Icon = elementIcons[key.split(':')[1]] ?? Mountain; return <li key={key} className="easy-tile"><Icon aria-hidden="true"/><span>{entry.name}</span><small>{entry.length ? `${Math.round(entry.length)} m` : `${entry.count} ${entry.count === 1 ? 'element' : 'elements'}`}</small></li>; })}</ul>
    </>}
  </section>;
}

function Choices({ value, onChange, disabled, support = false }: { value: Decision; onChange: (value: Decision) => void; disabled?: boolean; support?: boolean }) {
  const choices: [Decision, string][] = support ? [['yes', 'Yes, help me prepare'], ['change', 'Not now'], ['unknown', 'I am not sure']] : [['yes', 'Yes, this is right'], ['change', 'I need to change this'], ['unknown', 'I am not sure']];
  return <div className="easy-form-choices" role="group" aria-label={support ? 'Choose whether you need support paperwork' : 'Check this answer'}>{choices.map(([choice, label]) => <Button key={choice} variant={value === choice ? 'primary' : 'secondary'} aria-pressed={value === choice} disabled={disabled} onClick={() => onChange(choice)}>{label}</Button>)}</div>;
}

export function EasyFarmFormPage() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const farms = useRecords('farms');
  const supplied = params.get('farm_id');
  const valid = params.getAll('farm_id').length <= 1 && (supplied === null || UUID.test(supplied));
  const farmId = supplied?.toLowerCase() ?? (farms.items.length === 1 ? farms.items[0].id : '');
  const available = farms.items.some(farm => farm.id === farmId);
  return <div className="easy-farm-form"><PageHeader title="Your farm, one step at a time" description="Check your farm details, record crop changes and get the right paperwork ready."/>
    {farms.error && <Notice kind="error">{farms.error}<Button variant="secondary" onClick={() => void farms.reload()}>Try opening my farms again</Button></Notice>}
    {!valid && <Notice kind="error">Choose a farm from your workspace. This farm link could not be checked.</Notice>}
    {farms.loading ? <Notice>Opening your farms…</Notice> : <Field label="Farm"><select value={available ? farmId : ''} onChange={event => setParams(event.target.value ? { farm_id: event.target.value } : {}, { replace: true })}><option value="">Choose your farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field>}
    {!farms.loading && !farms.items.length && <p><Link to="/app/fields">Add your farm</Link> to start with your own records.</p>}
    {!farms.loading && supplied && valid && !available && <Notice kind="warning">That farm is not available through your current access. No other farm has been selected in its place.</Notice>}
    {session && valid && available && <FarmQuestions key={`${session.user.id}/${session.workspace.id}/${farmId}`} farmId={farmId} workspaceId={session.workspace.id} scope={`${session.user.id}/${session.workspace.id}`}/>}
  </div>;
}

function FarmQuestions({ farmId, workspaceId, scope }: { farmId: string; workspaceId: string; scope: string }) {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setBundle(null); setError('');
    void (async () => {
      const farm = await api.get<RecordItem>(`/farms/${farmId}`);
      if (farm.id !== farmId || farm.workspace_id !== workspaceId) throw new Error('The saved farm does not match the farm you selected.');
      const [fields, country] = await Promise.all([
        api.get<{ farm_id: string; revision: number; items: Parcel[] }>(`/farms/${farmId}/fields`),
        api.get<Country>(`/countries/${encodeURIComponent(String(farm.data.country))}`),
      ]);
      if (fields.farm_id !== farm.id || fields.revision !== farm.revision || country.country !== farm.data.country || !Array.isArray(fields.items) || !Array.isArray(country.modules)) throw new Error('The saved farm details changed while opening this form. Open them again before continuing.');
      if (active) setBundle({ farm, fields: fields.items, country });
    })().catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [farmId, workspaceId, generation]);
  return <>{error ? <Notice kind="error">{error}<Button variant="secondary" onClick={() => setGeneration(value => value + 1)}>Open the latest saved details</Button></Notice> : !bundle ? <Notice>Opening the saved farm, fields and country forms…</Notice> : <QuestionSteps bundle={bundle} scope={scope} refresh={() => setGeneration(value => value + 1)}/>}</>;
}

function QuestionSteps({ bundle, scope, refresh }: { bundle: Bundle; scope: string; refresh: () => void }) {
  const { session } = useSession();
  const { farm, fields, country } = bundle;
  const draftName = `easy-farm-form:${farm.id}`;
  const initial: Draft = { version: 1, farmRevision: farm.revision, step: 1, identity: '', fields: '', crops: {}, features: '', featureNote: '', support: '' };
  const draft = usePrivateDraft<Draft>(draftName, initial);
  const [saveError, setSaveError] = useState('');
  const [moving, setMoving] = useState(false);
  const [cropIndex, setCropIndex] = useState(0);
  const [proposalChecks, setProposalChecks] = useState<{ binding: string; current: Record<string, boolean> }>({ binding: '', current: {} });
  const heading = useRef<HTMLHeadingElement | null>(null);
  const [advisers, setAdvisers] = useState<{ user_id: string; display_name: string }[] | null>(null);
  const [sendKey, setSendKey] = useState(() => crypto.randomUUID());
  const [sentTo, setSentTo] = useState('');
  const [adviserId, setAdviserId] = useState('');
  const value = draft.value;
  const step = Number.isInteger(value.step) && value.step >= 1 && value.step <= 6 ? value.step : 1;
  const stale = value.farmRevision !== farm.revision;
  const selected = fields[Math.min(cropIndex, Math.max(0, fields.length - 1))];
  const cropEdit = selected ? value.cropEdits?.[selected.id] : undefined;
  const validGeometry = !!selected && hasValidOutline(selected);
  const spanishSnapshot = selected ? resolveSpanishDemo(farm, selected) : null;
  const storedProposals = fields.flatMap(field => {
    const saved = value.cropEdits?.[field.id];
    return saved?.proposalId ? [{ fieldId: field.id, edit: saved }] : [];
  });
  const proposalBinding = JSON.stringify([scope, farm.id, farm.revision, storedProposals]);
  const currentProposal = (fieldId: string) => proposalChecks.binding === proposalBinding && proposalChecks.current[fieldId] === true;
  const mayReview = session?.workspace.role === 'owner' || session?.workspace.permissions?.includes('review') === true;
  const mapFields: MapField[] = fields.filter(hasValidOutline).map(field => ({ id: field.id, group: field.id, reference: field.external_id ?? null, label: field.name, geometry: field.geometry!, detail: field.crop ?? undefined, crop: field.crop ?? null }));
  const totalArea = fields.reduce((sum, field) => sum + (field.approximate_area_ha ?? 0), 0);
  const cropOptions = [...new Set(fields.map(field => field.crop).filter((crop): crop is string => !!crop))];
  const supportModules = country.modules.filter(module => module.workflow_id === 'cap');
  const sourceHref = `/app/fields/${farm.id}`;
  const checkHref = `${sourceHref}/check?${new URLSearchParams({ expected_farm_revision: String(farm.revision), reporting_year: String(farm.data.reporting_year) })}`;
  const editorHref = selected ? `${sourceHref}?${new URLSearchParams({ parcel_id: selected.id, expected_farm_revision: String(farm.revision) })}#boundaries-${farm.id}` : sourceHref;
  const cropsAnswered = fields.every(field => !!value.crops[field.id] && (value.crops[field.id] !== 'change' || currentProposal(field.id)));
  const canContinue = step === 1 ? !!value.identity : step === 2 ? !!value.fields : step === 3 ? cropsAnswered : step === 4 ? !!value.features : step === 5 ? !!value.support : true;
  const concerns = [value.identity, value.fields, ...fields.map(field => value.crops[field.id] ?? ''), value.features].filter(choice => choice !== 'yes').length + (value.support === 'unknown' || !value.support ? 1 : 0);

  useEffect(() => {
    if (draft.ready) heading.current?.focus({ preventScroll: true });
  }, [step, draft.ready]);

  useEffect(() => {
    if (!draft.ready) return;
    let active = true;
    const controller = new AbortController();
    const current: Record<string, boolean> = {};
    let next = 0;
    // Two readers keep a large farm's retained changes from flooding the API.
    const read = async () => {
      while (active && next < storedProposals.length) {
        const { fieldId, edit } = storedProposals[next++];
        try {
          if (!UUID.test(edit.proposalId!) || !Number.isInteger(edit.proposalRevision)) throw new Error('Invalid retained proposal reference.');
          const proposal = await (await api.downloadResponse(`/field-proposals/${edit.proposalId}`, { signal: controller.signal })).json() as RecordItem;
          current[fieldId] = proposal.id === edit.proposalId && proposal.revision === edit.proposalRevision && proposal.workspace_id === farm.workspace_id &&
            proposal.data.farm_id === farm.id && proposal.data.base_farm_revision === farm.revision && proposal.data.status === 'proposed' &&
            proposal.data.parcel?.id === fieldId && proposal.data.parcel?.crop === (edit.crop === 'other' ? edit.custom : edit.crop);
        } catch { current[fieldId] = false; }
      }
    };
    void Promise.all([read(), read()]).then(() => { if (active) setProposalChecks({ binding: proposalBinding, current }); });
    return () => { active = false; controller.abort(); };
  }, [proposalBinding, draft.ready]);

  useEffect(() => {
    if (step !== 6 || session?.workspace.role !== 'owner') return;
    let active = true;
    api.get<{ items: { user_id: string; display_name: string }[] }>(`/adviser/recipients?farm_id=${farm.id}`)
      .then(result => { if (active) { setAdvisers(result.items); setAdviserId(previous => previous || result.items[0]?.user_id || ''); } }).catch(() => { if (active) setAdvisers([]); });
    return () => { active = false; };
  }, [step, farm.id]);
  const checklist: [boolean, string][] = [
    [value.identity === 'yes', `Farm details: ${decisionLabel[value.identity].toLowerCase()}`],
    [value.fields === 'yes', `${fields.length} ${fields.length === 1 ? 'field' : 'fields'}, about ${totalArea.toLocaleString(undefined, { maximumFractionDigits: 2 })} ha: ${decisionLabel[value.fields].toLowerCase()}`],
    [fields.every(field => value.crops[field.id] === 'yes'), `${fields.filter(field => value.crops[field.id] === 'yes').length} of ${fields.length} crops confirmed${storedProposals.length ? `, ${storedProposals.length} change proposed` : ''}`],
    [value.features === 'yes', `Land features: ${decisionLabel[value.features].toLowerCase()}${value.featureNote ? ' (note added)' : ''}`],
    [value.support === 'yes' || value.support === 'change', `Support paperwork: ${value.support === 'yes' ? 'help wanted' : value.support === 'change' ? 'not now' : 'not sure yet'}`],
  ];
  async function sendToAdviser() {
    const adviser = advisers?.find(item => item.user_id === adviserId);
    if (!adviser || moving) return;
    setMoving(true); setSaveError('');
    try {
      const body = [`Easy form answers for ${farm.data.name}.`, ...checklist.map(([done, text]) => `${done ? 'Done' : 'To check'}: ${text}`),
        ...(value.featureNote ? [`Notes: ${value.featureNote}`] : []), 'Sent from the Funkyfarm easy form. Nothing was filed with an authority.'].join('\n');
      await api.post('/adviser/questions', { farm_id: farm.id, recipient_id: adviser.user_id, title: `Easy form check: ${String(farm.data.name).slice(0, 140)}`, body: body.slice(0, 8000) }, { idempotencyKey: sendKey });
      setSentTo(adviser.display_name);
    } catch (failure) { setSaveError(errorMessage(failure)); setSendKey(crypto.randomUUID()); }
    finally { setMoving(false); }
  }
  function edit(patch: Partial<Draft>) { draft.setValue(previous => ({ ...previous, ...patch })); }
  async function move(next: number, patch: Partial<Draft> = {}) {
    setMoving(true); setSaveError('');
    try {
      const saved = { ...value, ...patch, step: next };
      await saveDraft(scope, draftName, saved);
      draft.setValue(saved);
      window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    } catch (failure) { setSaveError(errorMessage(failure)); }
    finally { setMoving(false); }
  }
  function editCrop(patch: Partial<CropEdit>) {
    if (!selected) return;
    edit({ cropEdits: { ...value.cropEdits, [selected.id]: { crop: 'other', custom: '', note: '', ...cropEdit, ...patch, attempt: crypto.randomUUID(), proposalId: undefined, proposalRevision: undefined } } });
  }
  async function saveCropProposal() {
    if (!selected || !cropEdit || moving || stale || !mayReview) return;
    setMoving(true); setSaveError('');
    try {
      const crop = cropEdit.crop === 'other' ? cropEdit.custom : cropEdit.crop;
      if (!crop.trim() || crop.length > 200) throw new Error('Choose a crop or type its name, up to 200 characters.');
      if (crop === selected.crop) throw new Error('This is already the saved crop. Choose “Yes, this is right” if it has not changed.');
      if (!UUID.test(cropEdit.attempt)) throw new Error('The crop-change retry reference could not be read. Choose the crop again.');
      await saveDraft(scope, draftName, value);
      const proposal = await api.post<RecordItem>(`/farms/${farm.id}/field-proposals`, {
        expected_revision: farm.revision,
        parcel: { id: selected.id, name: selected.name, geometry: selected.geometry ?? null, point: selected.point ?? null,
          crop, greenhouse: selected.greenhouse ?? false, notes: selected.notes ?? '', external_id: selected.external_id ?? null },
        note: cropEdit.note || 'Crop change entered by the farmer in the Easy form; awaiting separate review.',
      }, { idempotencyKey: cropEdit.attempt });
      if (!UUID.test(proposal.id) || proposal.workspace_id !== farm.workspace_id || proposal.data.farm_id !== farm.id || proposal.data.status !== 'proposed') throw new Error('The crop proposal could not be checked. Retry the same saved change before creating another.');
      const saved = { ...value, cropEdits: { ...value.cropEdits, [selected.id]: { ...cropEdit, proposalId: proposal.id, proposalRevision: proposal.revision } } };
      await saveDraft(scope, draftName, saved);
      draft.setValue(saved);
    } catch (failure) { setSaveError(errorMessage(failure)); }
    finally { setMoving(false); }
  }
  return <section className="easy-form-paper" aria-label="Farm questions">
    {farm.data.origin === 'sigpac_public_demo_2026_10_17' && <span className="badge">Demo</span>}
    <div className="easy-form-progress"><span>Step {step} of 6</span><progress max={6} value={step} aria-label="Current form step"/><span>{farm.data.name}</span></div>
    <h2 ref={heading} tabIndex={-1}>{titles[step - 1]}</h2>
    {!draft.ready && <Notice>Opening your saved answers…</Notice>}
    {(draft.error || saveError) && <Notice kind="error">{saveError || draft.error}</Notice>}
    {stale && <Notice kind="warning"><p>The farm changed since you started this form. Check the latest details before keeping these answers.</p><Button variant="secondary" disabled={!draft.ready || moving} onClick={() => edit({ ...initial, featureNote: value.featureNote })}>Start these checks again with the latest details</Button></Notice>}
    {step === 3 && cropEdit?.proposalId && !currentProposal(selected.id) && <Notice kind="warning">Check the earlier crop change before continuing. <Link to={`${sourceHref}?${new URLSearchParams({ proposal_id: cropEdit.proposalId, expected_revision: String(cropEdit.proposalRevision) })}#boundaries-${farm.id}`}>Open its review</Link>.</Notice>}
    {step === 6 && storedProposals.some(saved => !currentProposal(saved.fieldId)) && <Notice kind="warning">An earlier crop change needs another check. Use its review link below.</Notice>}
    <fieldset className="easy-form-content" disabled={!draft.ready || stale || moving}>
      {step === 1 && <><p>Are these the details you use for your farm?</p><div className="easy-card"><span className="easy-source">From your saved records</span><p className="easy-identity"><UserRound aria-hidden="true"/><strong>{farm.data.name || 'Your farm'}</strong></p><dl className="easy-form-readback"><div><dt>Farm name</dt><dd>{farm.data.name || 'Not recorded'}</dd></div><div><dt>Country</dt><dd>{country.name}</dd></div><div><dt>Region</dt><dd>{farm.data.region || 'Not recorded'}</dd></div><div><dt>Year in the saved farm</dt><dd>{farm.data.reporting_year ?? 'Not recorded'}</dd></div><div><dt>Type of farm</dt><dd>{String(farm.data.farm_type || 'Not recorded').replaceAll('_', ' ')}</dd></div></dl></div><Choices value={value.identity} onChange={identity => edit({ identity })}/>{value.identity === 'change' && <p><Link to={sourceHref}>Open your farm details to make the change</Link>. Use Back to return to this form; the saved details will be checked again.</p>}{value.identity === 'unknown' && <p>We will keep this as a question to check.</p>}</>}
      {step === 2 && <><p className="easy-summary"><b>{fields.length} {fields.length === 1 ? 'field' : 'fields'}</b> · about {totalArea.toLocaleString(undefined, { maximumFractionDigits: 2 })} ha{farm.data.country === 'ES' ? <span className="easy-source">Map from SIGPAC (FEGA)</span> : farm.data.country === 'NL' ? <span className="easy-source">Map from BRP (RVO)</span> : null}</p><p>{spanishSnapshot ? 'Public SIGPAC references with a staged private outline.' : 'Compare the fields saved in your workspace.'}</p>{fields.length ? <><div className="easy-form-field-picker" role="group" aria-label="Choose a field to see on the map">{fields.map((field, index) => <Button key={field.id} variant={selected?.id === field.id ? 'primary' : 'secondary'} aria-pressed={selected?.id === field.id} onClick={() => setCropIndex(index)}>{field.name}</Button>)}</div><div className="easy-form-map"><SigpacMap title="Your fields on the official map" fields={mapFields} focusGroup={selected.id}/></div>{selected.geometry && !validGeometry && <Notice kind="warning"><p>The saved outline needs repair before it can be shown.</p>{selected.geometry_summary?.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}<Link to={editorHref}>Review and repair this field outline</Link></Notice>}<p><strong>{selected.name}</strong>{selected.approximate_area_ha != null ? ` · about ${selected.approximate_area_ha.toLocaleString(undefined, { maximumFractionDigits: 3 })} ha from the saved outline` : ' · add an outline to see its area'}.</p><p className="muted">Drawn area and claimable area are different; check the source figures separately.</p></> : <p>No fields are saved yet. You can continue with this marked as needing a check, or <Link to={sourceHref}>add your first field</Link>.</p>}<Choices value={value.fields} onChange={answer => edit({ fields: answer })}/>{value.fields === 'change' && <p><Link to={editorHref}>Open the field editor</Link>. Changes saved there still need normal review.</p>}</>}
      {step === 3 && <>{fields.length ? <><p>Check each field. If the crop changed, choose it below or type another name.</p><div className="easy-form-field-picker" role="group" aria-label="Choose a field to check its crop">{fields.map((field, index) => <Button key={field.id} variant={selected?.id === field.id ? 'primary' : 'secondary'} aria-pressed={selected?.id === field.id} onClick={() => setCropIndex(index)}>{field.name}<span className="easy-form-field-choice">{decisionLabel[value.crops[field.id] ?? '']}</span></Button>)}</div><article className="easy-form-crop" aria-label={`Crop for ${selected.name}`}><h3>{selected.name}</h3><p>Saved crop:</p><strong>{selected.crop || 'No crop recorded'}</strong></article><Choices value={value.crops[selected.id] ?? ''} onChange={answer => edit({ crops: { ...value.crops, [selected.id]: answer } })}/>{value.crops[selected.id] === 'change' && <section className="easy-form-crop-change" aria-label="Save a crop change"><div className="easy-tiles" role="group" aria-label="Pick the crop">{cropTiles.map(([label, Icon]) => <button key={label} type="button" className="easy-tile" aria-pressed={cropEdit?.crop === 'other' && cropEdit.custom === label} onClick={() => editCrop({ crop: 'other', custom: label })}><Icon aria-hidden="true"/><span>{label}</span></button>)}</div><Field label="Crop"><select value={cropEdit?.crop ?? 'other'} onChange={event => editCrop({ crop: event.target.value })}>{cropOptions.map(crop => <option key={crop} value={crop}>{crop}</option>)}<option value="other">Other crop — type its name</option></select></Field>{(!cropEdit || cropEdit.crop === 'other') && <><Field label="Other crop name"><input value={cropEdit?.custom ?? ''} maxLength={200} onChange={event => editCrop({ custom: event.target.value })}/></Field><VoiceButton label="Say the crop" onText={text => editCrop({ crop: 'other', custom: cropFromSpeech(text) })}/></>}<Field label="What changed? (optional)"><input value={cropEdit?.note ?? ''} maxLength={4000} onChange={event => editCrop({ note: event.target.value })}/></Field>{cropEdit?.proposalId ? <Notice kind={currentProposal(selected.id) ? "success" : "warning"}>{currentProposal(selected.id) ? "Crop change saved for review." : "Earlier crop proposal retained; check its current version."} <Link to={`${sourceHref}?${new URLSearchParams({ proposal_id: cropEdit.proposalId, expected_revision: String(cropEdit.proposalRevision) })}#boundaries-${farm.id}`}>Review and apply this crop change</Link>.</Notice> : <Button disabled={!mayReview || !cropEdit || !(cropEdit.crop === 'other' ? cropEdit.custom.trim() : cropEdit.crop)} loading={moving} onClick={() => void saveCropProposal()}>Save crop change for review</Button>}{!mayReview && <p>Your current access cannot save a field change. Ask the farm owner or a permitted reviewer.</p>}</section>}<p>{fields.filter(field => !!value.crops[field.id]).length} of {fields.length} fields answered.</p></> : <p>No field crop records are available. You can add them from My fields when you have the details.</p>}</>}
      {step === 4 && <><p>Think about hedges, ponds, trees, buildings, scrub or other land features. Do your saved field notes cover what needs checking?</p><OfficialElements fields={fields} country={farm.data.country}/><div className="easy-tiles" role="group" aria-label="Add something the map is missing">{featureTiles.map(([label, Icon]) => <button key={label} type="button" className="easy-tile is-add" onClick={() => edit({ featureNote: `${value.featureNote ? value.featureNote + '\n' : ''}Add: ${label.toLowerCase()} on ${selected?.name ?? 'a field'}` })}><Icon aria-hidden="true"/><span>Add {label.toLowerCase()}</span></button>)}</div>{fields.some(field => !!field.notes) ? <details><summary>Read saved field notes</summary><ul>{fields.filter(field => !!field.notes).map(field => <li key={field.id}><strong>{field.name}:</strong> {field.notes}</li>)}</ul></details> : <p>No field notes saved yet. Add anything that needs checking.</p>}<Choices value={value.features} onChange={features => edit({ features })}/><Field label="Anything to check later? (optional)"><textarea maxLength={4000} rows={3} value={value.featureNote} onChange={event => edit({ featureNote: event.target.value })}/></Field><p><Link to={`/app/documents?farm_id=${farm.id}`}>Add an actual photo, lease or other record</Link> if you have one. You can leave this to check later.</p></>}
      {step === 5 && <><p>These are the support forms listed for {country.name}. Check which one applies to your farm.</p>{supportModules.length ? supportModules.map((module, index) => <article key={`${module.name}:${index}`} className="easy-form-support"><h3>{module.name}</h3><p>{module.task}</p><details><summary>What is covered?</summary><p>{module.coverage_limit || 'Check the actual scheme and authority instructions before preparing an application.'}</p></details></article>) : <p>No support module is listed for this country. Keep the real request and ask the recipient or an adviser which scheme applies.</p>}<Choices support value={value.support} onChange={support => edit({ support })}/><p>Preparing a form does not enrol you in a scheme.</p></>}
      {step === 6 && <><p>Check your answers before opening the next task.</p><ul className="easy-checklist">{checklist.map(([done, text]) => <li key={text} className={done ? 'is-done' : 'is-open'}>{done ? <CircleCheck aria-hidden="true"/> : <TriangleAlert aria-hidden="true"/>}{text}</li>)}</ul><Notice kind="warning"><strong>You are responsible.</strong> Read the summary before anything is sent. Your adviser helps; the paying agency decides.</Notice><div className="easy-form-handoff easy-send">{session?.workspace.role === 'owner' && (advisers === null ? <span className="muted">Checking your advisers…</span> : advisers.length ? <>{advisers.length > 1 && <Field label="Send to"><select value={adviserId} onChange={event => setAdviserId(event.target.value)}>{advisers.map(item => <option key={item.user_id} value={item.user_id}>{item.display_name}</option>)}</select></Field>}<Button loading={moving} disabled={!!sentTo} onClick={() => void sendToAdviser()}><Send aria-hidden="true"/>Send to my adviser</Button></> : <Link className="button button-secondary" to="/app/adviser">Invite an adviser first</Link>)}<Link className="button button-ghost" to="/app/home">Finish later</Link></div>{sentTo && <Notice kind="success">Sent to {sentTo}. Their reply will appear in <Link to={`/app/my-adviser?farm_id=${farm.id}`}>My adviser</Link>.</Notice>}<dl className="easy-form-readback"><div><dt>Your farm</dt><dd>{farm.data.name}: {decisionLabel[value.identity]}</dd></div><div><dt>Fields</dt><dd>{decisionLabel[value.fields]}</dd></div>{fields.map(field => <div key={field.id}><dt>{field.name}: saved crop</dt><dd>{field.crop || 'Not recorded'} — {decisionLabel[value.crops[field.id] ?? '']}{value.cropEdits?.[field.id]?.proposalId && <p><Link to={`${sourceHref}?${new URLSearchParams({ proposal_id: value.cropEdits[field.id].proposalId!, expected_revision: String(value.cropEdits[field.id].proposalRevision) })}#boundaries-${farm.id}`}>Review the saved crop change</Link>: {value.cropEdits[field.id].crop === 'other' ? value.cropEdits[field.id].custom : value.cropEdits[field.id].crop}</p>}</dd></div>)}<div><dt>Land features and notes</dt><dd>{decisionLabel[value.features]}{value.featureNote && <p className="easy-form-note">{value.featureNote}</p>}</dd></div><div><dt>Support paperwork</dt><dd>{value.support === 'yes' ? 'You would like help preparing it' : value.support === 'change' ? 'Not now' : 'You are not sure yet'}</dd></div></dl><Notice kind={concerns || !fields.length ? 'warning' : 'info'}>{concerns || !fields.length ? 'Some details still need checking. You can keep working through the tasks below.' : 'Your answers are recorded in this form. Check the figures and review the paperwork next.'}</Notice><div className="easy-form-handoff"><Link className="button button-primary" to={checkHref}>Check my fields and saved figures</Link><Link className="button button-secondary" to={`/app/documents?${new URLSearchParams({ farm_id: farm.id, purpose: 'last_application' })}`}>Import a letter or previous application</Link><Link className="button button-secondary" to={`/app/paperwork?${new URLSearchParams({ farm_id: farm.id, intent: 'support' })}`}>Open my support paperwork</Link></div><p>Crop changes are saved as proposals until you review and apply them. Sending an application is a separate step.</p></>}
    </fieldset>
    <div className="easy-form-navigation">{step > 1 && <Button variant="secondary" disabled={!draft.ready || moving} onClick={() => void move(step - 1)}>Back</Button>}{step === 4 && <Button variant="ghost" disabled={!draft.ready || stale || moving} onClick={() => void move(5, { features: 'unknown' })}>Skip for now</Button>}{step < 6 && <Button disabled={!draft.ready || stale || !canContinue || moving} loading={moving} onClick={() => void move(step + 1)}>Continue</Button>}{step === 6 && <Button variant="secondary" onClick={refresh}>Check the latest saved farm details</Button>}</div>
    {draft.saving ? <p role="status" className="muted">Saving your private draft…</p> : draft.ready && <p className="muted">Your choices are kept privately on this device when you go Back or reload.</p>}
    <p className="easy-form-source muted">These are your saved records. <Link to={sourceHref}>Open the farm details</Link>. Official filing is a separate step.</p>
  </section>;
}
