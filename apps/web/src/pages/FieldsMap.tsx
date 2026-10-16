import { useEffect, useId, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../api';
import { Button, Field, Notice, useSession } from '../components';
import { usePrivateDraft } from '../offline';
import type { Page, RecordItem } from '../types';
import { IacsReference } from './IacsReference';
import './fields-map.css';

export type FieldGeometry = { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
export type FieldPoint = { latitude: number; longitude: number };
type Bounds = [number, number, number, number];

function partsOf(geometry?: FieldGeometry | null): number[][][][] {
  return geometry?.type === 'Polygon' ? [geometry.coordinates as number[][][]] : geometry?.type === 'MultiPolygon' ? geometry.coordinates as number[][][][] : [];
}
function boundsOf(geometries: (FieldGeometry | null | undefined)[]): Bounds | undefined {
  const points = geometries.flatMap(geometry => partsOf(geometry).flat(2)).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return points.length ? points.reduce<Bounds>((b,p)=>[Math.min(b[0],p[0]),Math.min(b[1],p[1]),Math.max(b[2],p[0]),Math.max(b[3],p[1])],[Infinity,Infinity,-Infinity,-Infinity]) : undefined;
}

export function FieldMap({ geometry, point, label = 'Your supplied field outline', viewBounds }: { geometry?: FieldGeometry | null; point?: FieldPoint | null; label?: string; viewBounds?: Bounds }) {
  const titleId = useId();
  const captionId = useId();
  const rawParts = geometry?.type === 'Polygon' ? [geometry.coordinates as number[][][]] : geometry?.type === 'MultiPolygon' ? geometry.coordinates as number[][][][] : [];
  const parts = rawParts.filter(p => Array.isArray(p) && p.length && p.every(ring => Array.isArray(ring) && ring.length >= 4 && ring.every(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))));
  const positions = parts.flat(2);
  if (!positions.length && (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude))) return <div className="empty-state"><p>No location supplied for this field yet.</p></div>;
  const centerLon = viewBounds ? (viewBounds[0] + viewBounds[2]) / 2 : positions.length ? positions.reduce((sum, p) => sum + p[0], 0) / positions.length : point!.longitude;
  const centerLat = viewBounds ? (viewBounds[1] + viewBounds[3]) / 2 : positions.length ? positions.reduce((sum, p) => sum + p[1], 0) / positions.length : point!.latitude;
  const cosine = Math.max(.001, Math.cos(centerLat * Math.PI / 180));
  const projected = positions.map(p => [(p[0] - centerLon) * cosine, p[1] - centerLat]);
  const width = viewBounds ? Math.max(.0001, (viewBounds[2] - viewBounds[0]) * cosine) : Math.max(.0001, ...projected.map(p => Math.abs(p[0]) * 2));
  const height = viewBounds ? Math.max(.0001, viewBounds[3] - viewBounds[1]) : Math.max(.0001, ...projected.map(p => Math.abs(p[1]) * 2));
  const scale = Math.min(520 / width, 230 / height);
  const x = (lon: number) => 300 + (lon - centerLon) * cosine * scale;
  const y = (lat: number) => 155 - (lat - centerLat) * scale;
  return <figure style={{ margin: 0 }}><svg viewBox="0 0 600 310" role="img" aria-labelledby={`${titleId} ${captionId}`} style={{ display: 'block', width: '100%', maxHeight: 350, borderRadius: 14, background: '#eef1e9', border: '1px solid #c9d0c0' }}>
    <title id={titleId}>{label}</title><desc id={captionId}>{positions.length ? 'Outline drawn only from supplied coordinates. No background map or official parcel boundary is implied.' : 'Supplied location point only. No field boundary or area has been established.'}</desc>
    {[60,120,180,240,300,360,420,480,540].map(v => <path key={v} d={`M${v} 0V310`} stroke="#dfe4d8" strokeWidth="1" />)}
    {[45,100,155,210,265].map(v => <path key={v} d={`M0 ${v}H600`} stroke="#dfe4d8" strokeWidth="1" />)}
    {parts.map((part, i) => <path key={i} d={part.map(ring => ring.map((p,j) => `${j ? 'L' : 'M'}${x(p[0])} ${y(p[1])}`).join(' ') + 'Z').join(' ')} fill="#86a77e" fillOpacity=".55" fillRule="evenodd" stroke="#344c3b" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />)}
    {!positions.length && <><circle cx="300" cy="155" r="14" fill="#344c3b" /><circle cx="300" cy="155" r="4" fill="white" /></>}
    <text x="570" y="32" textAnchor="middle" fontSize="14" fill="#344c3b">N</text><path d="M570 43V66M565 49L570 43L575 49" stroke="#344c3b" fill="none" />
    <text x="20" y="290" fontSize="12" fill="#43513f">{centerLat.toFixed(5)}°, {centerLon.toFixed(5)}°</text>
  </svg><figcaption className="muted" style={{ marginTop: 8, fontSize: '.85rem' }}>{positions.length ? 'Your supplied outline · local projection · no basemap · not an official LPIS boundary.' : 'Your supplied location · point only · field area unknown.'}</figcaption></figure>;
}

type Parcel = { id: string; name: string; geometry?: FieldGeometry | null; point?: FieldPoint | null; crop?: string | null; greenhouse?: boolean; external_id?: string | null; approximate_area_ha?: number | null; revision?: number; active?: boolean };
type BoundaryDraft = { baseRevision: number; operation: 'draw' | 'edit' | 'split' | 'merge'; parentIds: string[]; geometry: FieldGeometry | null; sketch: number[][]; splitLine: number[][]; name: string; crop: string; greenhouse: boolean; externalId: string; note: string; latitude: string; longitude: string; reference: FieldGeometry | null; referenceSource: string; referenceId: string; referenceCrop: string; referenceYear: number | null; savedId: string; savedRevision: number; retryKey: string };
function blankDraft(revision: number): BoundaryDraft { return { baseRevision: revision, operation: 'draw', parentIds: [], geometry: null, sketch: [], splitLine: [], name: '', crop: '', greenhouse: false, externalId: '', note: '', latitude: '', longitude: '', reference: null, referenceSource: '', referenceId: '', referenceCrop: '', referenceYear: null, savedId: '', savedRevision: 0, retryKey: crypto.randomUUID() }; }

function OutlineEditor({ geometry, reference, point, sketch, splitLine, mode, onGeometry, onSketch, onSplitLine }: {
  geometry: FieldGeometry | null; reference: FieldGeometry | null; point?: FieldPoint; sketch: number[][]; splitLine: number[][];
  mode: 'draw' | 'edit' | 'split'; onGeometry: (value: FieldGeometry) => void; onSketch: (value: number[][]) => void; onSplitLine: (value: number[][]) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const [part, setPart] = useState(0);
  const [zoom, setZoom] = useState(1);
  const title = useId();
  const [bounds,setBounds] = useState<Bounds | undefined>(()=>boundsOf([geometry,reference]));
  const lon0 = bounds ? (bounds[0] + bounds[2]) / 2 : point?.longitude;
  const lat0 = bounds ? (bounds[1] + bounds[3]) / 2 : point?.latitude;
  if (lon0 === undefined || lat0 === undefined) return <Notice>Add a location or load an existing boundary file before drawing. No map position has been guessed.</Notice>;
  const cosine = Math.max(.001, Math.cos(lat0 * Math.PI / 180));
  const span = Math.max(.001, bounds ? Math.max((bounds[2] - bounds[0]) * cosine, (bounds[3] - bounds[1]) * 1.8) * 1.5 : .003) / zoom;
  const scale = 540 / span;
  const x = (p: number[]) => 300 + (p[0] - lon0) * cosine * scale;
  const y = (p: number[]) => 170 - (p[1] - lat0) * scale;
  function position(event: PointerEvent<SVGElement>) {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return null;
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [Number((lon0! + (local.x - 300) / scale / cosine).toFixed(8)), Number((lat0! - (local.y - 170) / scale).toFixed(8))];
  }
  const parts = partsOf(geometry);
  const ring = parts[part]?.[0] ?? [];
  function moveCorner(index: number, value: number[]) {
    const next = structuredClone(parts);
    next[part][0][index] = value;
    if (index === 0) next[part][0][next[part][0].length - 1] = value;
    onGeometry(geometry!.type === 'Polygon' ? { type: 'Polygon', coordinates: next[0] } : { type: 'MultiPolygon', coordinates: next });
  }
  function changeCornerCount(index:number,insert:boolean){
    const next=structuredClone(parts);
    const outer=next[part][0].slice(0,-1);
    if(insert){const a=outer[index],b=outer[(index+1)%outer.length];outer.splice(index+1,0,[(a[0]+b[0])/2,(a[1]+b[1])/2]);}
    else {if(outer.length<=3)return;outer.splice(index,1);}
    next[part][0]=[...outer,outer[0]];
    onGeometry(geometry!.type==='Polygon'?{type:'Polygon',coordinates:next[0]}:{type:'MultiPolygon',coordinates:next});
  }
  function keyCorner(event: KeyboardEvent<SVGCircleElement>, index: number) {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const amount = (event.shiftKey ? 10 : 1) / scale;
    moveCorner(index, [ring[index][0] + (event.key === 'ArrowLeft' ? -amount / cosine : event.key === 'ArrowRight' ? amount / cosine : 0), ring[index][1] + (event.key === 'ArrowDown' ? -amount : event.key === 'ArrowUp' ? amount : 0)]);
  }
  const path = (value: FieldGeometry | null) => partsOf(value).map(poly => poly.map(ring => ring.map((p,index) => `${index ? 'L' : 'M'}${x(p)} ${y(p)}`).join(' ') + 'Z').join(' ')).join(' ');
  return <div className="boundary-canvas-wrap"><div className="boundary-toolbar"><Button variant="secondary" onClick={() => setZoom(value => Math.min(8,value * 1.5))}>Zoom in</Button><Button variant="secondary" onClick={() => setZoom(value => Math.max(.25,value / 1.5))}>Zoom out</Button><Button variant="secondary" onClick={()=>{setBounds(boundsOf([geometry,reference]));setZoom(1);}}>Fit supplied outlines</Button>{parts.length > 1 && <Field label="Part to edit"><select value={part} onChange={event => setPart(Number(event.target.value))}>{parts.map((_,index) => <option value={index} key={index}>Part {index+1}</option>)}</select></Field>}</div>
    <p id={title}>{mode === 'draw' ? 'Tap each corner around the field, then choose Close boundary. Add exact coordinates below if you prefer.' : mode === 'split' ? 'Tap outside one edge, then beyond the opposite edge to mark the dividing line.' : 'Drag a corner to adjust the boundary. Keyboard: focus a corner and use arrow keys; Shift moves farther.'}</p>
    <svg ref={svg} className="boundary-canvas" viewBox="0 0 600 340" aria-labelledby={title} role="group"
      onPointerDown={event => { if (drag.current !== null) return; const p=position(event); if (!p) return; if (mode==='draw') onSketch([...sketch,p]); if(mode==='split') onSplitLine(splitLine.length>=2?[p]:[...splitLine,p]); }}
      onPointerMove={event => { if (drag.current===null) return; const p=position(event); if(p) moveCorner(drag.current,p); }}
      onPointerUp={() => {drag.current=null;}} onPointerCancel={() => {drag.current=null;}}>
      <rect width="600" height="340" fill="#edf0e6" />{[60,120,180,240,300,360,420,480,540].map(v=><path key={v} d={`M${v} 0V340`} stroke="#dce2d2"/>)}{[50,110,170,230,290].map(v=><path key={v} d={`M0 ${v}H600`} stroke="#dce2d2"/>)}
      {reference && <path d={path(reference)} fill="none" stroke="#a36e2a" strokeWidth="2" strokeDasharray="7 5" fillRule="evenodd" />}
      {geometry && <path d={path(geometry)} fill="#9db894" fillOpacity=".55" fillRule="evenodd" stroke="#304b37" strokeWidth="2.5" />}
      {mode==='draw' && sketch.length>0 && <><polyline points={sketch.map(p=>`${x(p)},${y(p)}`).join(' ')} fill="none" stroke="#1e553a" strokeWidth="3"/>{sketch.map((p,index)=><circle key={index} cx={x(p)} cy={y(p)} r="5" fill="#1e553a"/>)}</>}
      {splitLine.length>0 && <><polyline points={splitLine.map(p=>`${x(p)},${y(p)}`).join(' ')} stroke="#a44129" strokeWidth="3" strokeDasharray="7 4" fill="none"/>{splitLine.map((p,index)=><circle key={index} cx={x(p)} cy={y(p)} r="6" fill="#a44129"/>)}</>}
      {mode==='edit' && ring.slice(0,-1).map((p,index)=><circle key={index} cx={x(p)} cy={y(p)} r="7" fill="white" stroke="#24452e" strokeWidth="2" tabIndex={0} role="button" aria-label={`Corner ${index+1}; longitude ${p[0]}, latitude ${p[1]}`} onKeyDown={event=>keyCorner(event,index)} onPointerDown={event=>{event.stopPropagation();drag.current=index;svg.current?.setPointerCapture(event.pointerId);}} />)}
      <text x="570" y="25" fill="#344b36">N ↑</text><text x="14" y="323" fill="#344b36" fontSize="12">Supplied coordinates only · no aerial background</text>
    </svg>
    {mode==='draw' && <div className="actions"><Button disabled={sketch.length<3} onClick={()=>{onGeometry({type:'Polygon',coordinates:[[...sketch,sketch[0]]]});onSketch([]);}}>Close boundary</Button><Button variant="secondary" disabled={!sketch.length} onClick={()=>onSketch(sketch.slice(0,-1))}>Undo last corner</Button></div>}
    {mode==='split' && <Button variant="secondary" disabled={!splitLine.length} onClick={()=>onSplitLine([])}>Redraw dividing line</Button>}
    {mode==='edit' && ring.length>0 && <details><summary>Adjust corners using coordinates</summary><p>Excluded inner areas remain as saved. These controls adjust the outer edge.</p><div className="boundary-corners">{ring.slice(0,-1).map((p,index)=><div className="boundary-coordinate-row" key={index}><span>Corner {index+1}</span><Field label="Longitude"><input type="number" step="any" value={p[0]} onChange={event=>{if(event.target.value!==''&&Number.isFinite(event.target.valueAsNumber))moveCorner(index,[event.target.valueAsNumber,p[1]]);}}/></Field><Field label="Latitude"><input type="number" step="any" value={p[1]} onChange={event=>{if(event.target.value!==''&&Number.isFinite(event.target.valueAsNumber))moveCorner(index,[p[0],event.target.valueAsNumber]);}}/></Field><div className="actions"><Button variant="ghost" disabled={ring.length>=500} onClick={()=>changeCornerCount(index,true)}>Insert corner after {index+1}</Button><Button variant="ghost" disabled={ring.length<=4} onClick={()=>changeCornerCount(index,false)}>Remove corner {index+1}</Button></div></div>)}</div></details>}
  </div>;
}

export function FieldBoundaryWorkspace({farm,onSaved}:{farm:RecordItem;onSaved:(farm:RecordItem)=>void}) {
  const {session}=useSession();
  const canReview=session?.workspace.role==='owner'||session?.workspace.permissions?.includes('review')===true;
  const draft=usePrivateDraft<BoundaryDraft>(`boundary-workspace:${farm.id}`,blankDraft(farm.revision));
  const value=draft.value;
  const [open,setOpen]=useState(false);
  const [fields,setFields]=useState<Parcel[]>([]);
  const [proposals,setProposals]=useState<RecordItem[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [refresh,setRefresh]=useState(0);
  const [cornerLon,setCornerLon]=useState('');
  const [cornerLat,setCornerLat]=useState('');
  function set<K extends keyof BoundaryDraft>(key:K,next:BoundaryDraft[K]){draft.setValue(old=>({...old,[key]:next,retryKey:crypto.randomUUID()}));}
  useEffect(()=>{let active=true;void Promise.all([api.get<{items:Parcel[]}>(`/farms/${farm.id}/fields`),api.get<Page<RecordItem>>(`/farms/${farm.id}/field-proposals?limit=200`)]).then(([list,history])=>{if(active){setFields(list.items);setProposals(history.items);}}).catch(failure=>{if(active)setError(errorMessage(failure));});return()=>{active=false;};},[farm.id,farm.revision,refresh]);
  const chosen=fields.filter(field=>value.parentIds.includes(field.id));
  const validLocation=value.latitude.trim()!==''&&value.longitude.trim()!==''&&Number.isFinite(Number(value.latitude))&&Number.isFinite(Number(value.longitude));
  const point=validLocation?{latitude:Number(value.latitude),longitude:Number(value.longitude)}:undefined;
  function choose(operation:BoundaryDraft['operation'],field?:Parcel){draft.setValue({...blankDraft(farm.revision),operation,parentIds:field?[field.id]:[],geometry:field?.geometry??null,name:field?.name??'',crop:field?.crop??'',greenhouse:field?.greenhouse===true,externalId:field?.external_id??'',latitude:field?.point?String(field.point.latitude):'',longitude:field?.point?String(field.point.longitude):''});setOpen(true);setError('');setMessage('');}
  function parseBoundary(contents:string):FieldGeometry {let result=JSON.parse(contents);if(result.type==='Feature')result=result.geometry;if(result.type==='FeatureCollection'){if(result.features?.length!==1)throw new Error('Choose a file containing one field boundary.');result=result.features[0].geometry;}if(!result||!['Polygon','MultiPolygon'].includes(result.type))throw new Error('Choose a field boundary file containing a closed outline.');const parts=partsOf(result);if(!parts.length||parts.length>20)throw new Error('Choose a boundary with between one and twenty parts.');let count=0;for(const part of parts){if(!Array.isArray(part)||!part.length||part.length>20)throw new Error('Check the closed edges in this boundary file.');for(const ring of part){if(!Array.isArray(ring)||ring.length<4||ring.length>500)throw new Error('Each closed edge needs 4 to 500 corner positions.');count+=ring.length;if(count>1000||ring.some((p:number[])=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||Math.abs(p[0])>180||Math.abs(p[1])>90))throw new Error('Check the coordinates; use no more than 1,000 positions.');}}return result as FieldGeometry;}
  async function fileBoundary(file:File|undefined,reference=false){if(!file)return;try{if(file.size>1024*1024)throw new Error('Choose a boundary file under 1 MiB.');const geometry=parseBoundary(await file.text());if(reference){draft.setValue(old=>({...old,reference:geometry,referenceSource:file.name,referenceId:'',referenceCrop:'',referenceYear:null,retryKey:crypto.randomUUID()}));}else{set('geometry',geometry);set('sketch',[]);}setError('');}catch(failure){setError(errorMessage(failure));}}
  async function save(){setBusy(true);setError('');setMessage('');try{
    if(!value.note.trim())throw new Error('Briefly describe what changed or where the boundary came from.');
    const reference=value.reference||value.referenceId||value.referenceCrop?{geometry:value.reference,source:value.referenceSource||'Supplied for comparison',external_id:value.referenceId||null,crop:value.referenceCrop||null,year:value.referenceYear??null}:null;
    let result:RecordItem;
    if(value.operation==='split'||value.operation==='merge'){
      if(value.operation==='split'&&value.splitLine.length<2)throw new Error('Mark a dividing line across the field first.');
      result=await api.post<RecordItem>(`/farms/${farm.id}/field-proposals/transform`,{expected_revision:value.baseRevision,operation:value.operation,parcel_ids:value.parentIds,split_line:value.operation==='split'?{type:'LineString',coordinates:value.splitLine}:null,names:value.operation==='merge'&&value.name.trim()?[value.name.trim()]:[],crop:value.crop.trim()||null,greenhouse:value.greenhouse,note:value.note,reference},{idempotencyKey:value.retryKey});
    }else{
      if(!value.name.trim())throw new Error('Give this field a familiar name.');
      const parcel={...(value.parentIds[0]?{id:value.parentIds[0]}:{}),name:value.name.trim(),geometry:value.geometry,point:point??null,crop:value.crop.trim()||null,greenhouse:value.greenhouse,external_id:value.externalId.trim()||null};
      result=value.savedId?await api.patch<RecordItem>(`/field-proposals/${value.savedId}`,{expected_revision:value.savedRevision,expected_farm_revision:value.baseRevision,parcel,note:value.note,reference}):await api.post<RecordItem>(`/farms/${farm.id}/field-proposals`,{expected_revision:value.baseRevision,parcel,note:value.note,reference},{idempotencyKey:value.retryKey});
    }
    setProposals(old=>[result,...old.filter(item=>item.id!==result.id)]);await draft.clear();setOpen(false);setMessage('Your boundary change is saved in the workspace. Compare the old and proposed fields below before confirming.');
  }catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}}
  async function approve(record:RecordItem,acceptOverlap:boolean){
    if(busy||record.data.status!=='proposed')return;
    setBusy(true);setError('');setMessage('');
    try{
      const result=await api.post<{farm:RecordItem;proposal:RecordItem}>(`/field-proposals/${record.id}/approve`,{expected_revision:record.revision,expected_farm_revision:farm.revision,accept_overlap:acceptOverlap,note:'I compared the old and proposed fields and confirmed this private farm-record change.'},{idempotencyKey:`boundary-approve:${record.id}:${record.revision}:${farm.revision}:${acceptOverlap}`});
      setProposals(old=>old.map(item=>item.id===record.id?result.proposal:item));
      setMessage('Your farm fields were updated and their earlier outlines retained in history. No official register was changed.');
      setRefresh(count=>count+1);
      onSaved(result.farm);
    }catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}
  }
  async function download(record:RecordItem,format:'geojson'|'correction'){setBusy(true);setError('');try{const blob=await api.download(`/field-proposals/${record.id}/export?format=${format}`);const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=format==='geojson'?'field-correction-draft.geojson':'field-correction-handoff.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}}
  async function discard(record:RecordItem){setBusy(true);setError('');try{const saved=await api.post<RecordItem>(`/field-proposals/${record.id}/discard`,{expected_revision:record.revision,note:'Set aside by the user before applying.'});setProposals(old=>old.map(item=>item.id===record.id?saved:item));setMessage('This draft was set aside. The draft remains in history and your fields were not changed.');}catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}}
  function resume(record:RecordItem){const p=record.data.parcel as Parcel;draft.setValue({...blankDraft(record.data.base_farm_revision),operation:record.data.previous_parcel?'edit':'draw',parentIds:record.data.previous_parcel?[record.data.previous_parcel.id]:[],geometry:p.geometry??null,name:p.name,crop:p.crop??'',greenhouse:p.greenhouse===true,externalId:p.external_id??'',note:record.data.note??'',latitude:p.point?String(p.point.latitude):'',longitude:p.point?String(p.point.longitude):'',reference:record.data.reference?.geometry??null,referenceSource:record.data.reference?.source??'',referenceId:record.data.reference?.external_id??'',referenceCrop:record.data.reference?.crop??'',referenceYear:record.data.reference?.year??null,savedId:record.id,savedRevision:record.revision});setOpen(true);}
  return <section className="boundary-workspace" aria-labelledby={`boundaries-${farm.id}`}><header className="boundary-heading"><div><p className="eyebrow">Keep your field records in step</p><h2 id={`boundaries-${farm.id}`}>Change boundaries</h2><p>Draw a field, move its corners, divide it or join neighbouring fields. Compare first, then confirm.</p></div><div className="actions"><Button disabled={!draft.ready||busy} onClick={()=>{setOpen(true);setError('');}}>Open boundary tools</Button></div></header>
    {error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}{draft.error&&<Notice kind="warning">{draft.error}</Notice>}
    {open&&<div className="card boundary-editor"><fieldset className="draft-fields" disabled={!draft.ready||busy}><div className="boundary-choices"><Button variant={value.operation==='draw'?'primary':'secondary'} onClick={()=>choose('draw')}>Draw a field</Button><Button variant={value.operation==='edit'?'primary':'secondary'} disabled={!fields.length} onClick={()=>choose('edit',fields[0])}>Adjust a field</Button><Button variant={value.operation==='split'?'primary':'secondary'} disabled={!fields.some(p=>p.geometry)} onClick={()=>choose('split',fields.find(p=>p.geometry))}>Divide a field</Button><Button variant={value.operation==='merge'?'primary':'secondary'} disabled={fields.filter(p=>p.geometry).length<2} onClick={()=>choose('merge')}>Join fields</Button></div>
      {value.baseRevision!==farm.revision&&<Notice kind="warning">This draft started before the latest farm change. Your work is retained. <Button variant="secondary" onClick={()=>choose(value.operation,fields.find(p=>p.id===value.parentIds[0]))}>Start from the current fields</Button></Notice>}
      {(value.operation==='edit'||value.operation==='split')&&<Field label="Which field?"><select value={value.parentIds[0]??''} onChange={event=>choose(value.operation,fields.find(p=>p.id===event.target.value))}><option value="">Choose a field</option>{fields.filter(p=>value.operation==='edit'||p.geometry).map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></Field>}
      {value.operation==='merge'&&<fieldset><legend>Choose neighbouring fields to join</legend><div className="boundary-field-choices">{fields.filter(p=>p.geometry).map(p=><label key={p.id}><input type="checkbox" checked={value.parentIds.includes(p.id)} onChange={event=>set('parentIds',event.target.checked?[...value.parentIds,p.id]:value.parentIds.filter(id=>id!==p.id))}/>{p.name} <span className="muted">{p.crop||'Crop not recorded'}</span></label>)}</div><p>Shared edges disappear in the proposed joined field. Past work stays linked to its original field.</p><div className="boundary-comparison">{chosen.map(p=><FieldMap key={p.id} geometry={p.geometry} label={p.name} viewBounds={boundsOf(chosen.map(item=>item.geometry))}/>)}</div></fieldset>}
      {value.operation!=='merge'&&<><details open={!value.geometry&&!point}><summary>Locate this field or load its outline</summary><p>Use your own coordinates or a boundary file. The drawing grid is not aerial imagery.</p><div className="form-grid"><Field label="Latitude"><input inputMode="decimal" value={value.latitude} onChange={event=>set('latitude',event.target.value)}/></Field><Field label="Longitude"><input inputMode="decimal" value={value.longitude} onChange={event=>set('longitude',event.target.value)}/></Field><Field label="Existing boundary file"><input type="file" accept=".geojson,.json" onChange={event=>void fileBoundary(event.target.files?.[0])}/></Field></div></details>
        <OutlineEditor key={`${value.operation}:${value.parentIds.join(',')}:${value.savedId}:${value.geometry?'outline':'new'}:${point?.latitude??''}:${point?.longitude??''}`} geometry={value.geometry} reference={value.reference} point={point} sketch={value.sketch} splitLine={value.splitLine} mode={value.operation==='split'?'split':value.operation==='edit'&&value.geometry?'edit':value.geometry?'edit':'draw'} onGeometry={next=>set('geometry',next)} onSketch={next=>set('sketch',next)} onSplitLine={next=>set('splitLine',next)}/>
        {(!value.geometry||value.operation==='split')&&<details><summary>{value.operation==='split'?'Enter dividing line coordinates':'Add a corner with exact coordinates'}</summary><div className="form-grid"><Field label="Corner longitude"><input value={cornerLon} inputMode="decimal" onChange={event=>setCornerLon(event.target.value)}/></Field><Field label="Corner latitude"><input value={cornerLat} inputMode="decimal" onChange={event=>setCornerLat(event.target.value)}/></Field></div><Button variant="secondary" disabled={cornerLon.trim()===''||cornerLat.trim()===''} onClick={()=>{const p=[Number(cornerLon),Number(cornerLat)];if(p.every(Number.isFinite)){if(value.operation==='split')set('splitLine',[...value.splitLine,p]);else set('sketch',[...value.sketch,p]);setCornerLon('');setCornerLat('');}else setError('Enter two valid coordinates for this corner.');}}>{value.operation==='split'?'Add dividing line point':'Add corner'}</Button><p>{value.operation==='split'?value.splitLine.length:value.sketch.length} points added.</p>{!value.geometry&&<Button disabled={value.sketch.length<3} onClick={()=>{set('geometry',{type:'Polygon',coordinates:[[...value.sketch,value.sketch[0]]]});set('sketch',[]);}}>Close boundary from these corners</Button>}</details>}
      </>}
      <div className="form-grid">{value.operation!=='split'&&<Field label={value.operation==='merge'?'Joined field name':'Field name'}><input value={value.name} onChange={event=>set('name',event.target.value)} maxLength={200}/></Field>}<Field label="Crop after this change, if known"><input value={value.crop} onChange={event=>set('crop',event.target.value)} maxLength={200}/></Field>{!['split','merge'].includes(value.operation)&&<Field label="Recorded field reference, if known"><input value={value.externalId} onChange={event=>set('externalId',event.target.value)}/></Field>}</div><label className="boundary-check"><input type="checkbox" checked={value.greenhouse} onChange={event=>set('greenhouse',event.target.checked)}/>The resulting field is under greenhouse cover</label>
      <details><summary>Compare with another supplied outline or reference</summary><p>This comparison does not establish that a file is current or accepted by an authority.</p><div className="form-grid"><Field label="Comparison boundary file"><input type="file" accept=".geojson,.json" onChange={event=>void fileBoundary(event.target.files?.[0],true)}/></Field><Field label="Source or document name"><input value={value.referenceSource} onChange={event=>set('referenceSource',event.target.value)}/></Field><Field label="Reference on that document"><input value={value.referenceId} onChange={event=>set('referenceId',event.target.value)}/></Field><Field label="Crop on that document"><input value={value.referenceCrop} onChange={event=>set('referenceCrop',event.target.value)}/></Field><Field label="Year on the comparison source, if known"><input type="number" min="1900" max="2200" value={value.referenceYear??''} onChange={event=>set('referenceYear',event.target.value===''?null:event.target.valueAsNumber)}/></Field></div><IacsReference farm={farm} onSelect={reference=>draft.setValue(old=>({...old,reference:reference.geometry,referenceSource:reference.source,referenceId:reference.external_id??'',referenceCrop:reference.crop??'',referenceYear:reference.year,retryKey:crypto.randomUUID()}))}/>{value.reference&&<FieldMap geometry={value.reference} label="Supplied comparison outline"/>}</details>
      <Field label="What changed, or where did this outline come from?"><textarea value={value.note} onChange={event=>set('note',event.target.value)} maxLength={4000}/></Field><div className="actions"><Button loading={busy} disabled={value.baseRevision!==farm.revision||(value.operation==='merge'&&value.parentIds.length<2)} onClick={()=>void save()}>Save for comparison</Button><Button variant="secondary" onClick={()=>setOpen(false)}>Close and keep draft</Button></div><p className="muted" role="status">{draft.saving?'Saving your private draft on this device…':'Your unfinished draft is kept privately on this device. Save for comparison to keep it in the shared farm workspace.'}</p></fieldset></div>}
    <div className="boundary-saved-drafts">{proposals.filter(record=>record.data.status==='proposed').map(record=>{const data=record.data;const before:Parcel[]=data.previous_parcels??(data.previous_parcel?[data.previous_parcel]:[]);const after:Parcel[]=data.parcels??[data.parcel];const shared=boundsOf([...before.map(p=>p.geometry),...after.map(p=>p.geometry),data.reference?.geometry]);const stale=data.base_farm_revision!==farm.revision;return <article className="card boundary-proposal" key={`${record.id}:${record.revision}`}><header><p className="eyebrow">Saved change · {data.operation==='split'?'divide':data.operation==='merge'?'join':'adjust'} fields</p><h3>{after.map(p=>p.name).join(' + ')}</h3><p>{data.note}</p></header><div className="boundary-comparison"><section><h4>Saved before this change</h4>{before.length?before.map(p=><div key={p.id}><FieldMap geometry={p.geometry} point={p.point} label={p.name} viewBounds={shared}/><p><strong>{p.name}</strong><br/>{p.crop||'Crop not recorded'} · reference {p.external_id||'not recorded'}</p></div>):<p>No previous field; this adds a new record.</p>}</section><section><h4>Proposed fields</h4>{after.map(p=><div key={p.id}><FieldMap geometry={p.geometry} point={p.point} label={p.name} viewBounds={shared}/><p><strong>{p.name}</strong><br/>{p.crop||'Crop not recorded'} · reference {p.external_id||'not recorded'}</p></div>)}</section>{data.reference&&<section><h4>Supplied comparison</h4><FieldMap geometry={data.reference.geometry} label="Supplied comparison reference" viewBounds={shared}/><p>{data.reference.source}<br/>Crop: {data.reference.crop||'not recorded'}<br/>Reference: {data.reference.external_id||'not recorded'}</p><p className="muted">{data.reference.meaning}</p></section>}</div>
      {data.comparison&&<div className="boundary-area-review"><h4>Approximate outline areas</h4><div className="boundary-area-columns"><div><strong>Before</strong>{data.comparison.before.map((p:any)=><p key={p.id}>{p.name}: {p.geometry_summary.approximate_area_ha==null?'unknown':`${p.geometry_summary.approximate_area_ha} ha`}</p>)}</div><div><strong>Proposed</strong>{data.comparison.after.map((p:any)=><p key={p.id}>{p.name}: {p.geometry_summary.approximate_area_ha==null?'unknown':`${p.geometry_summary.approximate_area_ha} ha`}</p>)}</div></div><p>Difference: {data.comparison.approximate_area_change_ha==null?'unknown until both outlines are available':`${data.comparison.approximate_area_change_ha} ha`}. These approximate areas are not official eligible areas.</p></div>}
      <details><summary>Checks and retained history</summary><ul>{(data.warnings??[]).map((warning:string,index:number)=><li key={index}>{warning}</li>)}</ul><p>Based on farm revision {data.base_farm_revision}. {before.length} earlier field records and their work will remain in history.</p></details>{stale&&<Notice kind="warning">The farm changed after this draft was saved. Compare it with current fields and prepare a fresh change before confirming.</Notice>}
      <div className="actions"><Button variant="secondary" disabled={busy} onClick={()=>void download(record,'geojson')}>Download boundary file</Button><Button variant="secondary" disabled={busy} onClick={()=>void download(record,'correction')}>Download correction draft</Button>{!['split','merge'].includes(data.operation)&&<Button variant="ghost" disabled={busy||stale} onClick={()=>resume(record)}>Adjust saved draft</Button>}<Button variant="ghost" disabled={busy} onClick={()=>void discard(record)}>Set this draft aside</Button></div><p className="boundary-handoff">This updates your private farm records only. To correct an official register, take the downloaded draft to your adviser or authority through their accepted process. Nothing has been submitted.</p>
      {canReview&&<form onSubmit={event=>{event.preventDefault();const values=new FormData(event.currentTarget);void approve(record,values.get('overlap')==='on');}}><label className="boundary-check"><input type="checkbox" required disabled={stale||busy}/>I compared the field names, crops, outlines and reference details.</label>{(data.overlapping_fields??[]).length>0&&<label className="boundary-check"><input name="overlap" type="checkbox" required disabled={stale||busy}/>I checked the overlap with {data.overlapping_fields.map((p:any)=>p.name).join(', ')} and want to retain it.</label>}<Button type="submit" loading={busy} disabled={stale}>Confirm private field change</Button></form>}
    </article>;})}</div>
    {proposals.some(record=>record.data.status!=='proposed')&&<details className="boundary-history"><summary>Earlier boundary changes</summary><ul>{proposals.filter(record=>record.data.status!=='proposed').map(record=><li key={record.id}><strong>{(record.data.parcels??[record.data.parcel]).map((p:Parcel)=>p.name).join(' + ')}</strong> — {record.data.status==='approved'?'confirmed in private farm records':'set aside'}<div className="actions"><Button variant="ghost" disabled={busy} onClick={()=>void download(record,'geojson')}>Download retained boundary</Button><Button variant="ghost" disabled={busy} onClick={()=>void download(record,'correction')}>Download retained correction draft</Button></div></li>)}</ul></details>}
  </section>;
}
