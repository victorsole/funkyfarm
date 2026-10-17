import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { Button, Field, Notice, PageHeader } from '../components';
import { useRecords } from '../hooks';
import { useSession } from '../auth';
import { usePrivateDraft } from '../offline';
import type { RecordItem } from '../types';
import { useReviewAccess, type WorkflowHome } from './Core';
import { CzechJournal } from './CzechJournal';
import { PortugueseJournal } from './PortugueseJournal';
import { PppReadback, pppReadbackFields, readbackLabel, readbackValue as displayValue } from './PppReadback';
import './farm-work.css';

interface WorkDraft {
  type:string;date:string;parcel:string;product:string;crop:string;quantity:string;unit:string;
  amount:string;currency:string;category:string;note:string;source:string;source_note:string;
  document_id:string;purchase_use:string;quantity_basis:string;capture_id:string;edit_id:string;
  edit_kind:string;edit_revision:number;buyer:string;invoice_number:string;tax_amount:string;tax_rate:string;credit:string;
  treatment_type:string;product_authorisation:string;dose:string;dose_unit:string;treated_size:string;
  treated_unit:string;treated_location:string;start_time:string;eppo_code:string;bbch_stage:string;
  batch_number:string;contractor:string;operator:string;label_time_required:string;label_growth_stage_required:string;
}
interface CheckIssue {code:string;severity:'error'|'warning';field?:string;message:string;record_ids?:string[]}
interface WorkCheck {normalized_data:Record<string,any>;issues:CheckIssue[];can_save:boolean;requires_acknowledgement:string[];check_token:string}
const types = [
  {value:'purchase',label:'I bought something'},
  {value:'sale',label:'A sale or sales invoice'},
  {value:'fertiliser_application',label:'I used fertiliser'},
  {value:'pesticide_application',label:'I used a crop treatment'},
  {value:'irrigation',label:'I watered a field'},
  {value:'harvest',label:'I harvested a crop'},
  {value:'work',label:'I did other work'},
  {value:'observation',label:'I noticed something'},
  {value:'animal_birth',label:'Animals were born'},
  {value:'animal_death',label:'Animals died'},
  {value:'animal_purchase',label:'I bought animals'},
  {value:'animal_sale',label:'I sold animals'},
  {value:'animal_movement',label:'I moved animals'},
  {value:'animal_treatment',label:'I treated animals'},
];
const statusName = (status:unknown) => status === 'confirmed' ? 'Checked' : status === 'rejected' ? 'Rejected' : 'Needs checking';
const pppDraftDefaults={treatment_type:'',product_authorisation:'',dose:'',dose_unit:'',treated_size:'',treated_unit:'',treated_location:'',start_time:'',eppo_code:'',bbch_stage:'',batch_number:'',contractor:'',operator:'',label_time_required:'',label_growth_stage_required:''};
const emptyDraft = ():WorkDraft => ({type:'',date:'',parcel:'',product:'',crop:'',quantity:'',unit:'',amount:'',currency:'EUR',category:'',note:'',source:'manual',source_note:'',document_id:'',purchase_use:'bought_only',quantity_basis:'total',capture_id:crypto.randomUUID(),edit_id:'',edit_kind:'',edit_revision:0,buyer:'',invoice_number:'',tax_amount:'',tax_rate:'',credit:'',...pppDraftDefaults});
const sampleLabel = (value: unknown) => String(value ?? '').replace(/^\s*FICTIONAL(?:\s*[—–:-]\s*|\s+)/i, '');

function RecordSources({ record, documents }: { record: RecordItem; documents: RecordItem[] }) {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const sources = (Array.isArray(record.data.sources) ? record.data.sources : [])
    .filter((item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .filter((item: Record<string, unknown>) => Object.values(item).some(value => value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0)));
  if (typeof record.data.document_id === 'string' && uuid.test(record.data.document_id) && !sources.some((source: Record<string, unknown>) => source.document_id === record.data.document_id)) {
    sources.unshift({ kind: 'document', document_id: record.data.document_id });
  }
  if (!sources.length) return null;
  const sourceNames: Record<string, string> = { manual: 'Entered from farm records', document: 'Copied from a document', import: 'Copied from an imported file', annual_review: 'Checked against an earlier year', correction: 'Based on an earlier entry', source_dataset: 'Dataset source', satellite: 'Suggested from satellite data', example: 'Sample record' };
  const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  return <div><h4>Where these details came from</h4><ul>{sources.map((source: Record<string, unknown>, index: number) => {
    const documentId = typeof source.document_id === 'string' && uuid.test(source.document_id) ? source.document_id : null;
    const importId = typeof source.import_id === 'string' && uuid.test(source.import_id) ? source.import_id : null;
    const requestId = typeof source.request_id === 'string' && uuid.test(source.request_id) ? source.request_id : null;
    const recordId = typeof source.record_id === 'string' && uuid.test(source.record_id) ? source.record_id : null;
    const document = documents.find(item => item.id === documentId);
    const sourceName = source.source_name || source.filename || source.title;
    const sourceVersion = source.version || source.source_version || source.edition;
    let sourceUrl: string | null = null;
    try { const url = new URL(String(source.url || source.source_url || '')); if (url.protocol === 'https:' && !url.username && !url.password) sourceUrl = url.href; } catch { /* A source without a valid public URL remains readable here. */ }
    return <li key={index}><strong>{sourceNames[String(source.kind || source.source_kind || '')] || 'Saved source'}</strong>
      {typeof sourceName === 'string' && sourceName.length > 0 && <p>{sampleLabel(sourceName)}</p>}
      {typeof source.note === 'string' && source.note.trim() && <p>{source.note}</p>}
      {sourceUrl && <p><a href={sourceUrl} target="_blank" rel="noopener noreferrer">Open source information</a></p>}
      {(typeof sourceVersion === 'string' || typeof sourceVersion === 'number') && <p>Source edition: {String(sourceVersion)}</p>}
      {documentId && <p><Link to={`/app/documents/${documentId}`}>{document ? sampleLabel(document.data.title || document.data.filename || 'Open original document') : 'Open original document'}</Link>{positive(source.document_revision) && ` · version ${source.document_revision} cited`}</p>}
      {importId && <p><Link to={`/app/imports?${new URLSearchParams({ import: importId })}`}>Open the imported file</Link>{positive(source.row_number) && ` · row ${source.row_number}`}</p>}
      {requestId && <p><Link to={`/app/paperwork/${requestId}`}>Open the related request</Link>{positive(source.request_revision) && ` · version ${source.request_revision} cited`}</p>}
      {recordId && <p><Link to={source.record_kind === 'operations' ? `/app/record-work?${new URLSearchParams({ farm_id: record.data.farm_id, operation_id: recordId })}` : ['purchases', 'sales'].includes(String(source.record_kind)) ? `/app/record-work?${new URLSearchParams({ farm_id: record.data.farm_id, review: '1' })}` : `/app/fields/${record.data.farm_id}#facts`}>Open the earlier source record</Link>{positive(source.revision) && ` · version ${source.revision} cited`}</p>}
      {(typeof source.sha256 === 'string' || recordId || positive(source.source_year)) && <details><summary>Saved source details</summary><dl>
        {positive(source.source_year) && <><dt>Source year</dt><dd>{String(source.source_year)}</dd></>}
        {recordId && <><dt>Source record reference</dt><dd>{recordId}</dd></>}
        {typeof source.sha256 === 'string' && source.sha256 && <><dt>Original file check</dt><dd style={{ overflowWrap: 'anywhere' }}>{source.sha256}</dd></>}
      </dl></details>}
    </li>;
  })}</ul><p className="muted">Links open the current saved records. Any version cited by this entry is shown above.</p></div>;
}

export function RecordWorkPage() {
  const [params,setParams] = useSearchParams();
  const farms=useRecords('farms');
  const farmId=params.get('farm_id') || farms.items[0]?.id || '';
  const farm=farms.items.find(item=>item.id===farmId);
  const [home,setHome]=useState<WorkflowHome|null>(null);
  const [homeError,setHomeError]=useState<unknown>(null);
  useEffect(()=>{
    let active=true;setHome(null);setHomeError(null);
    if(!farmId)return;
    api.get<WorkflowHome>(`/workflow/home?farm_id=${encodeURIComponent(farmId)}`).then(result=>{if(active)setHome(result);}).catch(error=>{if(active)setHomeError(error);});
    return()=>{active=false;};
  },[farmId]);
  return <><PageHeader title="Notebook" description="Record work, purchases and sales. Check each entry before using it in a form." action={<Link className="button button-secondary" to={farmId?`/app/documents?farm_id=${farmId}`:'/app/documents'}>Add a photo or document</Link>}/>{farms.error&&<Notice kind="error">{farms.error}</Notice>}{homeError!==null&&<Notice kind="error">{errorMessage(homeError)}</Notice>}{farms.loading?<Notice>Opening your farms…</Notice>:!farms.items.length?<section className="card"><h2>Start with your farm</h2><p>Choose where and what you farm, then bring in your notebook or existing records.</p><Link className="button button-primary" to="/app/fields">Set up my farm</Link></section>:<><Field label="Farm"><select value={farmId} onChange={event=>setParams({farm_id:event.target.value})}>{farms.items.map(item=><option key={item.id} value={item.id}>{sampleLabel(item.data.name)}</option>)}</select></Field>{farm?.data.country==='CZ'&&<CzechJournal key={`journal-${farmId}`} farm={farm}/>} {farm?.data.country==='PT'&&<PortugueseJournal key={`pt-journal-${farmId}`} farm={farm}/>} {farm&&<WorkNotebook key={farmId} farm={farm} availableTypes={(home?.capture_types || types).filter(type=>farm.data.country!=='CZ'||type.value!=='pesticide_application')} initialField={params.get('field') || ''} initialReview={params.get('review') === '1'}/>}</>}</>;
}

function WorkNotebook({farm,availableTypes,initialField,initialReview}:{farm:RecordItem;availableTypes:{value:string;label:string}[];initialField:string;initialReview:boolean}) {
  const canReview=useReviewAccess();
  const {session}=useSession();
  const [sourceQuery]=useSearchParams();
  const selectedOperation=sourceQuery.get('operation_id');
  const operations=useRecords(`operations?farm_id=${encodeURIComponent(farm.id)}`);
  const purchases=useRecords(`purchases?farm_id=${encodeURIComponent(farm.id)}`);
  const sales=useRecords(`sales?farm_id=${encodeURIComponent(farm.id)}`);
  const documents=useRecords('documents');
  const initial=useRef({...emptyDraft(),parcel:initialField});
  const draft=usePrivateDraft<WorkDraft>(`record-work:${farm.id}`,initial.current);
  const [fields,setFields]=useState<{id?:string;name:string}[]>([]);
  const [fieldError,setFieldError]=useState<string|null>(null);
  const [check,setCheck]=useState<WorkCheck|null>(null);
  const [acknowledged,setAcknowledged]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<unknown>(null);
  const [saved,setSaved]=useState<RecordItem|null>(null);
  const [conflict,setConflict]=useState<RecordItem|null>(null);
  const [reviewNote,setReviewNote]=useState('');
  const [filter,setFilter]=useState(initialReview?'review':'all');
  const value=draft.value;
  const purchase=value.type==='purchase';
  const sale=value.type==='sale';
  const animal=value.type.startsWith('animal_');
  const usage=['fertiliser_application','pesticide_application','irrigation'].includes(value.type);
  const farmDocuments=documents.items.filter(item=>item.data.farm_id===farm.id || !item.data.farm_id);
  useEffect(()=>{
    if(!selectedOperation)return;
    let active=true;
    setSaved(null);setReviewNote('');setError(null);
    void api.get<RecordItem>(`/operations/${encodeURIComponent(selectedOperation)}`).then(record=>{
      if(record.kind!=='operations'||record.data.farm_id!==farm.id)throw new Error('This work record belongs to a different farm. Open it from that farm instead.');
      if(active){setSaved(record);setFilter('all');}
    }).catch(failure=>{if(active)setError(failure);});
    return()=>{active=false;};
  },[farm.id,selectedOperation,session?.user.id,session?.workspace.id,session?.workspace.farm_ids,session?.workspace.permissions]);
  useEffect(()=>{
    let active=true;
    api.get<{items:{id?:string;name:string}[]}>(`/farms/${farm.id}/fields`).then(result=>{if(active)setFields(result.items);}).catch(failure=>{if(active)setFieldError(errorMessage(failure));});
    return()=>{active=false;};
  },[farm.id,farm.revision]);
  function set<K extends keyof WorkDraft>(key:K,next:WorkDraft[K]) {
    draft.setValue(previous=>({...previous,[key]:next}));setCheck(null);setAcknowledged([]);setError(null);
  }
  function chooseType(type:string) {
    draft.setValue(previous=>({...previous,type,unit:type.startsWith('animal_')?'head':previous.type.startsWith('animal_')?'':previous.unit,quantity_basis:'total',...(type==='sale'&&previous.type!=='sale'?{currency:'',amount:'',category:'',buyer:'',invoice_number:'',tax_amount:'',tax_rate:'',credit:''}:{}),...(type==='purchase'&&previous.type==='sale'?{currency:'EUR',amount:'',category:''}:{})}));setCheck(null);setAcknowledged([]);setError(null);
  }
  function captureBody() {
    const label=availableTypes.find(type=>type.value===value.type)?.label || types.find(type=>type.value===value.type)?.label || 'Farm work';
    const unit=animal?'head':value.quantity_basis==='per_ha'&&value.unit?`${value.unit}/ha`:value.unit||null;
    const sources:Record<string,unknown>[]=[];
    if(value.source==='document'&&value.document_id)sources.push({kind:'document',document_id:value.document_id});
    else sources.push({kind:'manual',note:value.source==='notebook'?`Copied from notebook: ${value.source_note}`:'Entered from the farmer’s own record'});
    const data:Record<string,unknown>={farm_id:farm.id,title:purchase||sale?value.product.trim()||(sale?'Sale':'Purchase'):`${label}${value.product.trim()?` — ${value.product.trim()}`:''}`,date:value.date||null,quantity:value.quantity.trim()===''?null:value.quantity,unit,note:value.note.trim()||null,document_id:value.document_id||null,sources};
    if(!purchase&&!sale){
      const matches=fields.filter(field=>field.name===value.parcel.trim());
      // A typed name is not an identity when two fields share it. Preserve the
      // original identity only while editing that same historical field name.
      const original=operations.items.find(item=>item.id===value.edit_id);
      data.parcel_id=matches.length===1&&matches[0].id?matches[0].id:original?.data.parcel===value.parcel.trim()?original.data.parcel_id??null:null;
    }
    if(purchase||sale){data.category=value.category||'other';data.amount=value.amount.trim()===''?null:value.amount;data.currency=value.currency.toUpperCase();if(sale){data.buyer=value.buyer?.trim()||null;data.invoice_number=value.invoice_number?.trim()||null;data.tax_amount=value.tax_amount?.trim()?value.tax_amount:null;data.tax_rate=value.tax_rate?.trim()?value.tax_rate:null;data.credit=value.credit==='yes';}}
    else {data.type=value.type;data.parcel=value.parcel.trim()||null;data.product=value.product.trim()||null;data.crop=value.crop.trim()||null;if(value.type==='pesticide_application'){for(const key of ['treatment_type','product_authorisation','dose','dose_unit','treated_size','treated_unit','treated_location','start_time','eppo_code','bbch_stage','batch_number','contractor','operator'] as const)data[key]=value[key]?.trim()||null;for(const key of ['label_time_required','label_growth_stage_required'] as const)data[key]=value[key]==='yes'?true:value[key]==='no'?false:null;}}
    return {kind:purchase?'purchases':sale?'sales':'operations',data,reporting_year:farm.data.reporting_year||new Date().getFullYear(),...(value.edit_id?{record_id:value.edit_id,expected_revision:value.edit_revision}:{})};
  }
  async function checkEntry(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(farm.data.country==='CZ'&&value.type==='pesticide_application'){setError(new Error('This earlier crop-treatment draft is retained. Use the Czech crop-protection journal above to record its identifiers and follow-up before saving it.'));return;}
    setBusy(true);setError(null);setCheck(null);setAcknowledged([]);
    try {setCheck(await api.post<WorkCheck>('/workflow/check',captureBody()));}
    catch(failure){setError(failure);}finally{setBusy(false);}
  }
  async function saveEntry() {
    if(!check||!check.can_save)return;
    setBusy(true);setError(null);
    try {
      const result=await api.post<{record:RecordItem}>('/workflow/capture',{...captureBody(),acknowledged_codes:acknowledged,check_token:check.check_token},{idempotencyKey:value.capture_id});
      setSaved(result.record);setReviewNote('');setCheck(null);setAcknowledged([]);
      await draft.clear();draft.setValue(emptyDraft());await Promise.all([operations.reload(),purchases.reload(),sales.reload()]);
    } catch(failure){
      setError(failure);
      if(failure instanceof ApiError&&failure.status===409&&value.edit_id){
        try{setConflict(await api.get<RecordItem>(`/${value.edit_kind}/${value.edit_id}`));}catch{/* The original conflict remains visible and the draft remains intact. */}
        void operations.reload();void purchases.reload();void sales.reload();
      }
    }finally{setBusy(false);}
  }
  async function review(record:RecordItem,decision:string) {
    setBusy(true);setError(null);
    try {const result=await api.post<RecordItem>(`/${record.kind}/${record.id}/review`,{expected_revision:record.revision,decision,note:reviewNote});setSaved(result);await Promise.all([operations.reload(),purchases.reload(),sales.reload()]);}
    catch(failure){setError(failure);}finally{setBusy(false);}
  }
  function edit(record:RecordItem) {
    const data=record.data;
    const unit=String(data.unit||'');
    const next:WorkDraft={...emptyDraft(),type:record.kind==='purchases'?'purchase':record.kind==='sales'?'sale':data.type||'observation',date:data.date||'',parcel:data.parcel||'',product:data.product||data.title||'',crop:data.crop||'',quantity:data.quantity===null||data.quantity===undefined?'':String(data.quantity),unit:unit.endsWith('/ha')?unit.slice(0,-3):unit,quantity_basis:unit.endsWith('/ha')?'per_ha':'total',amount:data.amount===null||data.amount===undefined?'':String(data.amount),currency:data.currency||(record.kind==='sales'?'':'EUR'),category:data.category||'',note:data.note||data.notes||'',document_id:data.document_id||'',source:data.document_id?'document':'manual',edit_id:record.id,edit_kind:record.kind,edit_revision:record.revision,buyer:data.buyer||'',invoice_number:data.invoice_number||'',tax_amount:data.tax_amount==null?'':String(data.tax_amount),tax_rate:data.tax_rate==null?'':String(data.tax_rate),credit:data.credit===true?'yes':data.credit===false?'no':'',...Object.fromEntries(Object.keys(pppDraftDefaults).map(key=>[key,key==='label_time_required'||key==='label_growth_stage_required'?data[key]===true?'yes':data[key]===false?'no':'':data[key]==null?'':String(data[key])]))};
    draft.setValue(next);setSaved(null);setConflict(null);setCheck(null);setAcknowledged([]);document.getElementById('work-entry')?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
  }
  const all=[...operations.items,...purchases.items,...sales.items].filter(item=>item.data.farm_id===farm.id&&!(farm.data.country==='CZ'&&item.kind==='operations'&&item.data.type==='pesticide_application')).sort((a,b)=>String(b.data.date||b.created_at).localeCompare(String(a.data.date||a.created_at)));
  const visible=all.filter(item=>filter==='all'||filter==='review'&&item.data.review_status==='proposed'||filter===item.kind);
  const blockers=check?.requires_acknowledgement.filter(code=>!acknowledged.includes(code))||[];
  return <div className={`farm-record-work ${initialReview?'review-first':''}`}><div className="farm-work-layout"><section className="card" id="work-entry"><h2>{value.edit_id?'Change a saved entry':'What happened on the farm?'}</h2>{!canReview?<Notice>You can read this farm's records. Ask the owner for review permission to add or change entries.</Notice>:<>{fieldError&&<Notice kind="warning">Saved field names could not be loaded. You can still enter the name you use on the farm. {fieldError}</Notice>}<form className="stack" onSubmit={checkEntry}><fieldset disabled={!draft.ready||busy} className="draft-fields"><Field label="What would you like to record?"><select value={value.type} onChange={event=>chooseType(event.target.value)} required><option value="">Choose what happened</option>{availableTypes.map(type=><option key={type.value} value={type.value} disabled={!!value.edit_id&&(type.value==='purchase'?'purchases':type.value==='sale'?'sales':'operations')!==value.edit_kind}>{type.label}</option>)}</select></Field>{value.type&&<><div className="form-grid"><Field label={purchase?'Purchase date':sale?'Sale date':'When did it happen?'}><input type="date" value={value.date} onChange={event=>set('date',event.target.value)} required/></Field>{!purchase&&!sale&&<Field label={animal?'Where were the animals?':'Which field or growing area?'}><input list={`fields-${farm.id}`} value={value.parcel} onChange={event=>set('parcel',event.target.value)} placeholder="Use the name you know" required={usage||value.type==='harvest'}/><datalist id={`fields-${farm.id}`}>{fields.map((field,index)=><option value={field.name} label={sampleLabel(field.name)} key={field.id||index}/>)}</datalist></Field>}{!purchase&&!sale&&value.parcel.trim()!==''&&fields.filter(field=>field.name===value.parcel.trim()).length>1&&<Notice kind="warning">Several saved fields have this name. Check which field you mean before using this record in paperwork.</Notice>}<Field label={purchase?'What did you buy?':sale?'What did you sell?':animal?'Animal group or identification':usage?'Product used':value.type==='harvest'?'Crop harvested':'What did you do or notice?'}><input value={value.product} onChange={event=>set('product',event.target.value)} required maxLength={500}/></Field>{purchase&&<Field label="What kind of purchase?"><select value={value.category} onChange={event=>set('category',event.target.value)} required><option value="">Choose a category</option><option value="fertiliser">Fertiliser</option><option value="crop_treatment">Crop treatment</option><option value="seed">Seed or plants</option><option value="feed">Animal feed</option><option value="fuel">Fuel</option><option value="equipment">Equipment or repairs</option><option value="other">Other</option></select></Field>}{sale&&<><Field label="What kind of sale?"><select value={value.category} onChange={event=>set('category',event.target.value)} required><option value="">Choose a category</option><option value="crop">Crops or produce</option><option value="livestock">Livestock</option><option value="services">Services</option><option value="other">Other</option></select></Field><Field label="Buyer"><input value={value.buyer||''} onChange={event=>set('buyer',event.target.value)} required maxLength={500}/></Field><Field label="Invoice number (if shown)"><input value={value.invoice_number||''} onChange={event=>set('invoice_number',event.target.value)} maxLength={500}/></Field></>}<Field label={animal?'How many animals?':purchase?'Quantity bought (if shown)':sale?'Quantity sold (if shown)':value.type==='pesticide_application'?'Total product quantity (optional, if recorded)':value.type==='harvest'?'How much did you harvest?':usage?'How much did you use?':'Quantity (if relevant)'}><input inputMode={animal?'numeric':'decimal'} value={value.quantity} onChange={event=>set('quantity',event.target.value)} required={animal||(usage&&value.type!=='pesticide_application')||value.type==='harvest'} placeholder={animal?'A whole number':'For example, 25 or 25,5'}/></Field><Field label="Unit">{animal?<input value="head" readOnly aria-label="Unit: animals counted in head"/>:<select value={value.unit} onChange={event=>set('unit',event.target.value)} required={(usage&&value.type!=='pesticide_application')||value.type==='harvest'||value.quantity.trim()!==''}><option value="">Choose a unit, if known</option>{['kg','g','t','l','ml','m3','mm','ha','h','item',...(sale?['head']:[])].map(unit=><option key={unit} value={unit}>{unit==='l'?'litres (l)':unit==='m3'?'cubic metres (m³)':unit==='h'?'hours (h)':unit}</option>)}</select>}</Field>{['fertiliser_application','pesticide_application'].includes(value.type)&&<Field label="Does that quantity describe the whole job?"><select value={value.quantity_basis} onChange={event=>set('quantity_basis',event.target.value)}><option value="total">Yes, total quantity used</option><option value="per_ha">No, quantity used per hectare</option></select></Field>}{purchase&&<><Field label="Amount paid (a credit note can be negative)"><input inputMode="decimal" value={value.amount} onChange={event=>set('amount',event.target.value)} required/></Field><Field label="Currency"><input maxLength={3} pattern="[A-Za-z]{3}" value={value.currency} onChange={event=>set('currency',event.target.value.toUpperCase())} required/></Field></>}{sale&&<><Field label="Amount on invoice"><input inputMode="decimal" value={value.amount} onChange={event=>set('amount',event.target.value)} required/></Field><Field label="Currency shown on invoice"><input maxLength={3} pattern="[A-Za-z]{3}" placeholder="For example, EUR or PLN" value={value.currency} onChange={event=>set('currency',event.target.value.toUpperCase())} required/></Field><Field label="Tax amount printed on invoice (optional)"><input inputMode="decimal" value={value.tax_amount||''} onChange={event=>set('tax_amount',event.target.value)}/></Field><Field label="Tax rate printed on invoice (optional)"><input inputMode="decimal" value={value.tax_rate||''} onChange={event=>set('tax_rate',event.target.value)}/></Field><Field label="Is this a credit note or refund?"><select value={value.credit||''} onChange={event=>set('credit',event.target.value)} required><option value="">Choose yes or no</option><option value="no">No</option><option value="yes">Yes</option></select></Field><p className="muted">Copy the amount, currency and any printed tax directly from the sale or invoice. Tax and totals are not calculated here. An animal movement is a separate record.</p></>}</div>{purchase&&<fieldset><legend>Was this purchase also used on a field?</legend><label className="field"><span><input type="radio" checked={value.purchase_use==='bought_only'} onChange={()=>set('purchase_use','bought_only')}/> I am recording the purchase only</span></label><label className="field"><span><input type="radio" checked={value.purchase_use==='also_used'} onChange={()=>set('purchase_use','also_used')}/> It was also used — I will record the date, field and quantity separately</span></label><p className="muted">A receipt shows a purchase. It does not tell us when or where the product was used.</p></fieldset>}{value.type==='pesticide_application'&&<details open><summary>Details from the crop protection label and application record</summary><p>Record what actually happened. A purchase invoice does not establish the authorisation number, time, crop code or growth stage. You can save an incomplete proposal and add missing details before filing.</p><div className="form-grid"><Field label="What did you treat?"><select value={value.treatment_type||''} onChange={event=>{set('treatment_type',event.target.value);set('treated_unit','');}}><option value="">Not recorded yet</option><option value="surface">A field or crop surface</option><option value="closed_space">An enclosed facility</option><option value="seed">Seed</option></select></Field><Field label="Product authorisation number on the label"><input value={value.product_authorisation||''} onChange={event=>set('product_authorisation',event.target.value)} placeholder="Copy the number printed on the product label"/></Field><Field label="Person who applied it"><input value={value.operator||''} onChange={event=>set('operator',event.target.value)}/></Field><Field label="Contractor (if someone else applied it)"><input value={value.contractor||''} onChange={event=>set('contractor',event.target.value)}/></Field><Field label="Dose used for this application"><input inputMode="decimal" value={value.dose||''} onChange={event=>set('dose',event.target.value)}/></Field><Field label="Dose unit from the label or application record"><input value={value.dose_unit||''} onChange={event=>set('dose_unit',event.target.value)} placeholder="For example, l/ha or g/kg"/></Field><Field label={value.treatment_type==='closed_space'?'Actual size of the treated facility':value.treatment_type==='seed'?'Actual quantity of seed treated':'Actual area treated'}><input inputMode="decimal" value={value.treated_size||''} onChange={event=>set('treated_size',event.target.value)}/></Field><Field label="Unit for the treated size"><select value={value.treated_unit||''} onChange={event=>set('treated_unit',event.target.value)} disabled={!value.treatment_type}><option value="">{value.treatment_type?'Choose the recorded unit':'Choose what you treated first'}</option>{(value.treatment_type==='surface'?['ha']:value.treatment_type==='closed_space'?['m2','m3']:value.treatment_type==='seed'?['kg','t','seeds']:[]).map(unit=><option key={unit} value={unit}>{unit==='m2'?'square metres (m²)':unit==='m3'?'cubic metres (m³)':unit==='seeds'?'number of seeds':unit}</option>)}</select></Field><Field label="Actual field, facility or batch location"><input value={value.treated_location||''} onChange={event=>set('treated_location',event.target.value)}/></Field><Field label="Crop or use"><input value={value.crop||''} onChange={event=>set('crop',event.target.value)}/></Field><Field label="Application start time (if recorded)"><input type="time" value={value.start_time||''} onChange={event=>set('start_time',event.target.value)}/></Field><Field label="EPPO crop or use code (if recorded)"><input value={value.eppo_code||''} onChange={event=>set('eppo_code',event.target.value)}/></Field><Field label="BBCH growth stage (if recorded)"><input value={value.bbch_stage||''} onChange={event=>set('bbch_stage',event.target.value)}/></Field><Field label={value.treatment_type==='seed'?'Seed batch number':'Batch number (if recorded)'}><input value={value.batch_number||''} onChange={event=>set('batch_number',event.target.value)}/></Field><Field label="Does the product label require a start time?"><select value={value.label_time_required||''} onChange={event=>set('label_time_required',event.target.value)}><option value="">Not known / label not checked</option><option value="yes">Yes</option><option value="no">No</option></select></Field><Field label="Does the product label require a growth stage?"><select value={value.label_growth_stage_required||''} onChange={event=>set('label_growth_stage_required',event.target.value)}><option value="">Not known / label not checked</option><option value="yes">Yes</option><option value="no">No</option></select></Field></div><p className="muted">Use the actual treated area, enclosed space or seed batch, rather than the whole farm size. Keep the dose and its unit exactly as recorded.</p></details>}<Field label="Notes (optional)"><textarea value={value.note} onChange={event=>set('note',event.target.value)} placeholder="Add anything you will want to remember later"/></Field><details><summary>Where are you copying this from?</summary><Field label="Original record"><select value={value.source} onChange={event=>{set('source',event.target.value);if(event.target.value!=='document')set('document_id','');}}><option value="manual">My own note</option><option value="notebook">My farm notebook</option><option value="document">A saved photograph or document</option></select></Field>{value.source==='notebook'&&<Field label="Notebook date or page"><input value={value.source_note} onChange={event=>set('source_note',event.target.value)} required placeholder="For example, red notebook, page 14"/></Field>}{value.source==='document'&&<><Field label="Saved document"><select value={value.document_id} onChange={event=>set('document_id',event.target.value)} required><option value="">Choose a document</option>{farmDocuments.map(item=><option key={item.id} value={item.id}>{sampleLabel(item.data.filename||item.data.title||'Document')}</option>)}</select></Field><Link to={`/app/documents?farm_id=${farm.id}`}>Add a notebook photo or receipt</Link></>}</details><div className="actions"><Button type="submit" loading={busy}>Check this entry</Button>{value.edit_id&&<Button variant="secondary" onClick={()=>{draft.setValue(emptyDraft());setCheck(null);}}>Start a new entry</Button>}</div></>}</fieldset></form>{!draft.ready&&<Notice>Opening your saved draft…</Notice>}{draft.saving&&<p role="status" className="muted">Saving draft on this device…</p>}{draft.error&&<Notice kind="warning">{draft.error}</Notice>}</>}{error!==null&&<Notice kind="error">{errorMessage(error)}{error instanceof ApiError&&error.status===409&&<p>Your draft is still here. Open the latest saved entry below and compare it before trying again.</p>}</Notice>}
      {conflict&&<section className="farm-entry-check"><h3>Another version was saved</h3><p>Your entered values are still in the form. Compare them with the saved record before continuing.</p><dl className="farm-entry-summary">{['date','parcel','quantity','unit','amount','currency','buyer','invoice_number','tax_amount','tax_rate','credit','note',...pppReadbackFields.map(([key])=>key)].filter(key=>key in conflict.data).map(key=><div key={key}><dt>{readbackLabel(key)}</dt><dd>Saved: {displayValue(conflict.data[key])}</dd><dd>Your entry: {displayValue(captureBody().data[key])}</dd></div>)}</dl><Button variant="secondary" onClick={()=>{draft.setValue(previous=>({...previous,edit_revision:conflict.revision,capture_id:crypto.randomUUID()}));setConflict(null);setCheck(null);setError(null);}}>I compared them — check my entered values against this version</Button></section>}
      {check&&<section className="farm-entry-check"><h3>{check.can_save?'Check before saving':'A few details need attention'}</h3>{check.issues.map(issue=><div key={`${issue.code}:${issue.field||''}`} className={`notice notice-${issue.severity==='error'?'error':'warning'}`}><p>{issue.message}</p>{check.requires_acknowledgement.includes(issue.code)&&<label><input type="checkbox" checked={acknowledged.includes(issue.code)} onChange={event=>setAcknowledged(previous=>event.target.checked?[...previous,issue.code]:previous.filter(code=>code!==issue.code))}/> I checked this and want to keep these details.</label>}</div>)}<dl className="farm-entry-summary">{['title','date','parcel','product','quantity','unit','amount','currency','buyer','invoice_number','tax_amount','tax_rate','credit'].filter(key=>key in check.normalized_data&&check.normalized_data[key]!==null).map(key=><div key={key}><dt>{({title:'Entry',date:'Date',parcel:'Field or place',product:'Product or group',quantity:'Quantity',unit:'Unit',amount:'Amount',currency:'Currency',buyer:'Buyer',invoice_number:'Invoice number',tax_amount:'Printed tax amount',tax_rate:'Printed tax rate',credit:'Credit note or refund'} as Record<string,string>)[key]}</dt><dd>{displayValue(check.normalized_data[key])}</dd></div>)}</dl>{purchase&&value.purchase_use==='also_used'&&<p>After saving the purchase, add a separate work entry for the product you used.</p>}<PppReadback data={check.normalized_data}/><p className="muted">Save this entry first. You still need to check it.</p><Button loading={busy} disabled={!check.can_save||blockers.length>0} onClick={()=>void saveEntry()}>Save entry for checking</Button></section>}
      {saved&&<section className="farm-entry-check"><h3>{saved.data.review_status==='proposed'?'Entry saved. Check it now.':'Saved entry'}</h3><p><strong>{sampleLabel(saved.data.title)}</strong> · {saved.data.date}</p><p>{saved.data.quantity===null||saved.data.quantity===undefined?'':`${saved.data.quantity} ${saved.data.unit||''}`} {sampleLabel(saved.data.parcel)}</p><span className="badge">{statusName(saved.data.review_status)}</span>{saved.kind==='sales'&&<dl className="farm-entry-summary">{['buyer','invoice_number','amount','currency','tax_amount','tax_rate','credit'].map(key=><div key={key}><dt>{({buyer:'Buyer',invoice_number:'Invoice number',amount:'Amount on invoice',currency:'Currency',tax_amount:'Printed tax amount',tax_rate:'Printed tax rate',credit:'Credit note or refund'} as Record<string,string>)[key]}</dt><dd>{key==='credit'?saved.data.credit===true?'Yes':saved.data.credit===false?'No':'Not supplied':displayValue(saved.data[key])}</dd></div>)}</dl>}<PppReadback data={saved.data}/>{saved.data.review_status==='proposed'&&canReview&&<><p>Compare this with the notebook, receipt or work you carried out.</p><Field label="What did you check?"><input value={reviewNote} onChange={event=>setReviewNote(event.target.value)}/></Field><div className="actions"><Button loading={busy} onClick={()=>void review(saved,'confirmed')}>I checked this — confirm entry</Button><Button variant="secondary" loading={busy} onClick={()=>void review(saved,'rejected')}>Reject entry</Button></div></>}{saved.kind==='purchases'&&<p><Button variant="secondary" onClick={()=>{draft.setValue({...emptyDraft(),type:saved.data.category==='fertiliser'?'fertiliser_application':saved.data.category==='crop_treatment'?'pesticide_application':'work',product:saved.data.title||''});setSaved(null);}}>Record when and where I used it</Button></p>}</section>}
    </section><aside className="card farm-notebook-help"><h2>From a notebook or receipt</h2><p>You can copy a short entry here, or add a photograph and check the suggested details.</p><Link className="button button-secondary" to={`/app/documents?farm_id=${farm.id}&purpose=records`}>Add a photo or document</Link><details><summary>Prefer to dictate?</summary><p>Use the microphone on your device's keyboard to enter a note. Read the resulting text and correct names, dates and quantities before saving.</p></details><p className="muted">The original record is kept separately from checked entries.</p></aside></div>
    <section className="card"><div className="farm-section-heading"><h2>My work notebook</h2><Field label="Show"><select value={filter} onChange={event=>setFilter(event.target.value)}><option value="all">All entries</option><option value="review">Entries to check</option><option value="operations">Work and observations</option><option value="purchases">Purchases</option><option value="sales">Sales</option></select></Field></div>{(operations.error||purchases.error||sales.error)&&<Notice kind="error">{operations.error||purchases.error||sales.error}<Button variant="secondary" onClick={()=>{void operations.reload();void purchases.reload();void sales.reload();}}>Try again</Button></Notice>}{operations.loading||purchases.loading||sales.loading?<Notice>Opening your notebook…</Notice>:!visible.length?<p className="muted">No {filter==='review'?'entries waiting to be checked':'entries'} for this choice yet.</p>:<ul className="farm-notebook-list">{visible.map(record=><li key={record.id}><div><p className="farm-entry-date">{record.data.date?new Date(`${record.data.date}T12:00:00`).toLocaleDateString():new Date(record.created_at).toLocaleDateString()}</p><h3>{sampleLabel(record.data.title)}</h3><p>{sampleLabel(record.data.parcel)}{record.data.quantity===null||record.data.quantity===undefined?'':` · ${record.data.quantity} ${record.data.unit||''}`}{(record.kind==='purchases'||record.kind==='sales')?` · ${displayValue(record.data.amount)} ${record.data.currency||''}`:''}</p><span className="badge">{record.kind==='sales'?'Sale':record.kind==='purchases'?'Purchase':'Work'}</span> <span className="badge">{statusName(record.data.review_status)}</span><details><summary>Notes and original record</summary>{(record.data.note||record.data.notes)&&<p>{record.data.note||record.data.notes}</p>}<PppReadback data={record.data}/><p className="muted">Saved {new Date(record.updated_at).toLocaleString()} · entry version {record.revision}.</p><RecordSources record={record} documents={farmDocuments}/></details></div>{canReview&&<div className="actions">{record.data.review_status==='proposed'&&<Button variant="secondary" onClick={()=>{setSaved(record);setReviewNote('');document.getElementById('work-entry')?.scrollIntoView({block:'start'});}}>Check entry</Button>}{record.data.review_status==='confirmed'?<Button variant="ghost" onClick={()=>{setSaved(record);document.getElementById('work-entry')?.scrollIntoView({block:'start'});}}>View checked entry</Button>:<Button variant="ghost" onClick={()=>edit(record)}>Change details</Button>}</div>}</li>)}</ul>}</section></div>;
}
