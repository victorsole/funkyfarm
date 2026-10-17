import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { Button, Field, Notice } from '../components';
import { usePrivateDraft } from '../offline';
import type { RecordItem } from '../types';

export interface LuxembourgProfile {
  id:string;label:string;country:string;source_year:number;holding_column:string;identity_columns:string[];
  minimum_headers:string[];row_columns:{key:string;label:string;type:string;unit:string|null}[];
  definition_hash:string;notice:string;sources:{url:string;title:string;edition?:string}[];
}

export function LuxembourgRowValues({profile,columns,row}:{profile:LuxembourgProfile|undefined;columns:{header:string;source_index:number}[];row:RecordItem}) {
  return <details open><summary>Values kept from this source row</summary><dl className="form-grid">{columns.map(column=>{
    const definition=profile?.row_columns.find(field=>field.key===column.header);
    const raw=row.data.original_row[column.source_index];
    return <div key={column.source_index}><dt>{definition?`${definition.label} (${column.header})`:column.header}{definition?.unit?` · ${definition.unit}`:''}</dt><dd style={{overflowWrap:'anywhere'}}>{raw===undefined?'Cell absent':raw===''?'Empty source cell':String(raw)}</dd></div>;
  })}</dl><p className="muted">Text, codes and original units are retained. Source areas do not replace your field boundaries or establish eligible area.</p></details>;
}

export function useLuxembourgProfiles() {
  const [profiles,setProfiles]=useState<LuxembourgProfile[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const generation=useRef(0);
  const reload=useCallback(async()=>{
    const request=++generation.current;setLoading(true);setError(null);
    try{const result=await api.get<{items:LuxembourgProfile[]}>('/imports/profiles');if(request===generation.current)setProfiles(result.items);}
    catch(failure){if(request===generation.current)setError(errorMessage(failure));}
    finally{if(request===generation.current)setLoading(false);}
  },[]);
  useEffect(()=>{void reload();return()=>{generation.current+=1;};},[reload]);
  return {profiles,error,loading,reload};
}

export function LuxembourgUpload({profile,farms,initialFarmId,selectionKey,onUploaded}:{profile:LuxembourgProfile;farms:RecordItem[];initialFarmId:string;selectionKey:string;onUploaded:(record:RecordItem)=>Promise<void>}) {
  const luFarms=farms.filter(farm=>farm.data.country==='LU');
  const draft=usePrivateDraft(`lu-import-upload:${profile.id}`,{farm_id:luFarms.some(farm=>farm.id===initialFarmId)?initialFarmId:'',delimiter:'auto'});
  const appliedFarmLink=useRef('');
  useEffect(()=>{
    if(!initialFarmId){appliedFarmLink.current='';return;}
    if(!draft.ready||appliedFarmLink.current===initialFarmId||!luFarms.some(farm=>farm.id===initialFarmId))return;
    appliedFarmLink.current=initialFarmId;
    draft.setValue(previous=>({...previous,farm_id:initialFarmId}));
  },[initialFarmId,draft.ready,farms]);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const generation=useRef(0);
  const currentSelection=useRef(selectionKey);currentSelection.current=selectionKey;
  useEffect(()=>{setBusy(false);return()=>{generation.current+=1;};},[selectionKey]);
  async function upload(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const formElement=event.currentTarget;
    const form=new FormData(formElement);const file=form.get('file');
    if(!(file instanceof File)||!file.size){setError('Choose a CSV file with source rows.');return;}
    if(file.size>20*1024*1024){setError('Choose a CSV no larger than 20 MiB.');return;}
    if(!luFarms.some(farm=>farm.id===draft.value.farm_id)){setError('Choose the Luxembourg farm that owns this file.');return;}
    const request=++generation.current;const selection=currentSelection.current;setBusy(true);setError(null);
    form.set('farm_id',draft.value.farm_id);form.set('delimiter',draft.value.delimiter);
    form.set('format_profile',profile.id);form.set('source_year',String(profile.source_year));form.set('grain',profile.label);
    try{const imported=await api.upload<RecordItem>('/imports',form);if(request===generation.current&&selection===currentSelection.current)await onUploaded(imported);}
    catch(failure){if(request===generation.current)setError(errorMessage(failure));}
    finally{if(request===generation.current)setBusy(false);}
  }
  return <><p>Use the original Luxembourg 2026 export for <strong>{profile.label.toLowerCase()}</strong>. Column meanings are prepared for this source; you do not need to match columns.</p>{error&&<Notice kind="error">{error}</Notice>}{draft.error&&<Notice kind="warning">{draft.error}</Notice>}{!luFarms.length&&<Notice>Add a Luxembourg farm before bringing in this export. <Link to="/app/fields">Open My fields</Link>.</Notice>}<form className="stack" onSubmit={upload}><fieldset className="draft-fields" disabled={!draft.ready||busy}><div className="form-grid"><Field label="CSV file"><input name="file" type="file" accept=".csv,text/csv" required/></Field><Field label="Luxembourg farm"><select value={draft.value.farm_id} onChange={event=>draft.setValue(previous=>({...previous,farm_id:event.target.value}))} required><option value="">Choose the farm for this file</option>{luFarms.map(farm=><option key={farm.id} value={farm.id}>{farm.data.name}</option>)}</select></Field><Field label="Source year"><input value={String(profile.source_year)} readOnly/></Field><Field label="CSV separator"><select value={draft.value.delimiter} onChange={event=>draft.setValue(previous=>({...previous,delimiter:event.target.value}))}><option value="auto">Check the source headers automatically</option><option value=",">Comma</option><option value=";">Semicolon</option><option value={'\t'}>Tab</option></select></Field></div><p className="muted">Use UTF-8 CSV, up to 20 MiB. Blank cells, literal NULL and zero stay distinct. You will confirm the holding number and source before reviewing rows.</p><Button type="submit" loading={busy} disabled={!luFarms.length}>Open Luxembourg CSV for review</Button></fieldset></form></>;
}

export function LuxembourgSourceReview({imported,profile,canReview,requiresReview,onSaved,onReadyChange,onReload}:{imported:RecordItem;profile:LuxembourgProfile|undefined;canReview:boolean;requiresReview:boolean;onSaved:(record:RecordItem)=>void;onReadyChange:(ready:boolean)=>void;onReload:()=>Promise<void>}) {
  const [farm,setFarm]=useState<RecordItem|null>(null);
  const [decimal,setDecimal]=useState<string>(imported.data.profile_review?.decimal_separator||'');
  const [confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const generation=useRef(0);
  const signature=`${imported.id}:${imported.revision}:${imported.data.sha256}:${profile?.definition_hash||''}`;
  const currentSignature=useRef(signature);currentSignature.current=signature;
  const loadFarm=useCallback(async()=>{
    const request=++generation.current;setFarm(null);setError(null);setConfirmed(false);setBusy(false);
    try{const current=await api.get<RecordItem>(`/farms/${imported.data.farm_id}`);if(request===generation.current)setFarm(current);}
    catch(failure){if(request===generation.current)setError(errorMessage(failure));}
  },[imported.data.farm_id]);
  useEffect(()=>{void loadFarm();return()=>{generation.current+=1;};},[loadFarm,signature]);
  const review=imported.data.profile_review;
  const ready=!!(!requiresReview&&farm&&profile&&farm.data.country==='LU'&&imported.data.source_year===2026&&review?.confirmed_source===true&&review.profile_id===profile.id&&review.definition_hash===profile.definition_hash&&review.source_year===imported.data.source_year&&review.holding_reference===imported.data.holding_reference&&review.farm_revision===farm.revision&&review.decimal_separator===decimal);
  useEffect(()=>{onReadyChange(ready);},[ready,onReadyChange]);
  async function confirm(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!farm||!profile||!confirmed||!['.',','].includes(decimal))return;
    const request=++generation.current;const source=currentSignature.current;setBusy(true);setError(null);
    try{
      const result=await api.post<RecordItem>(`/imports/${imported.id}/profile-review`,{expected_revision:imported.revision,expected_farm_revision:farm.revision,holding_reference:imported.data.holding_reference,decimal_separator:decimal,confirm_source:true});
      if(request===generation.current&&source===currentSignature.current){setConfirmed(false);onSaved(result);}
    }catch(failure){if(request===generation.current)setError(errorMessage(failure));}
    finally{if(request===generation.current)setBusy(false);}
  }
  async function reloadCurrent() {
    const request=++generation.current;const source=currentSignature.current;
    onReadyChange(false);setConfirmed(false);setBusy(true);setError(null);
    try{await onReload();if(request===generation.current&&source===currentSignature.current)await loadFarm();}
    catch(failure){if(request===generation.current)setError(errorMessage(failure));}
    finally{if(request===generation.current)setBusy(false);}
  }
  return <section className="panel stack"><h3>Check the source before reusing rows</h3><p>{profile?.label||imported.data.format_profile} · source year {imported.data.source_year}</p>{error&&<Notice kind="error">{error}</Notice>}{!profile&&<Notice kind="warning">The prepared source definition is not available. Reload the source choices before reviewing this import.</Notice>}{!farm&&!error&&<Notice>Loading the current farm details…</Notice>}{farm&&<dl><div><dt>Selected farm</dt><dd>{farm.data.name} · {farm.data.country}{farm.data.region?` · ${farm.data.region}`:''}</dd></div><div><dt>Farm reporting year</dt><dd>{farm.data.reporting_year||'Not recorded'}</dd></div><div><dt>Original file</dt><dd>{imported.data.source_name}</dd></div><div><dt>File source year</dt><dd>{imported.data.source_year}</dd></div></dl>}{ready?<Notice kind="success">Source checked for this farm. Review the original rows below before saving proposals.</Notice>:review&&<Notice kind="warning">Check the current source and farm again before saving more proposals. The farm or prepared source definition may have changed.</Notice>}{canReview&&<form className="stack" onSubmit={confirm}><fieldset className="draft-fields" disabled={busy||!farm||!profile||requiresReview}><div className="form-grid"><Field label="Holding number in file"><input value={imported.data.holding_reference||''} readOnly/></Field><Field label="Decimal mark in this file"><select value={decimal} onChange={event=>{setDecimal(event.target.value);setConfirmed(false);}} required><option value="">Choose after checking the file</option><option value=".">Dot — for example, 12.5</option><option value=",">Comma — for example, 12,5</option></select></Field></div><label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} required/> I checked the holding number, 2026 source year and selected Luxembourg farm against this file.</label><p className="muted">The holding number is copied exactly from the original file. If it is wrong, correct the original export and upload it again.</p><Button type="submit" loading={busy} disabled={!confirmed||!decimal||!imported.data.holding_reference}>Confirm source and show rows</Button></fieldset></form>}<Button variant="secondary" disabled={busy} onClick={()=>void reloadCurrent()}>Reload current source and farm</Button><p>This keeps source rows for review. It does not change your field map, establish ownership or certification, calculate quota balances, or submit an application.</p>{profile&&<details><summary>Source columns, units and official reference</summary><p>{profile.notice}</p><ul>{profile.row_columns.map(column=><li key={column.key}>{column.label} ({column.key}){column.unit?` · original unit ${column.unit}`:''}</li>)}</ul><p>Area unit a means Ar; areas are not converted to hectares. Previous crop values remain previous-year information.</p>{profile.sources.map(source=><p key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>{source.edition?` · ${source.edition}`:''}</p>)}</details>}</section>;
}
