import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { Button, Field, Notice } from '../components';
import { usePrivateDraft } from '../offline';
import type { RecordItem } from '../types';
import type { FieldGeometry } from './FieldsMap';

export type IacsFieldReference = { geometry: FieldGeometry | null; external_id: string | null; crop: string | null; source: string; year: number | null };
type Coverage = { country: string; region: string | null; name: string; first_year: number; last_year: number; rights: string; limits?: string; redistribution?: string };
type Catalog = { version: string; url: string; citation: string; license: string; native_crs: string; accepted_subset_crs: string; max_rows: number; max_bytes: number; mandatory_columns: string[]; warnings: string[]; coverage: Coverage[]; coverage_meaning: string };
type Candidate = { external_id: string; crop_code: string; crop_name: string; hcat_code: string; source_area_ha: number; geometry: FieldGeometry | null; field_reference: IacsFieldReference | null; may_use_for_farm_administration: boolean };
type Preview = RecordItem<{ country: string; region: string | null; year: number; candidates: Candidate[]; warnings: string[]; provenance: { subset_sha256: string; upstream_file_name: string; rights_basis_supplied_by_user: string; upstream_file_checksum_verified: boolean }; next_action: string }> & { farm_context_changed?: boolean };
type ImportDraft = { country: string; region: string; year: string; format: 'geojson' | 'csv'; fileName: string; upstreamName: string; checksum: string; content: string; rights: string; purpose: 'private_reference' | 'noncommercial_research'; coordinatesConfirmed: boolean; contextConfirmed: boolean; areaConfirmed: boolean; previewId: string; retryKey: string };

export function IacsReference({ farm, onSelect }: { farm: RecordItem; onSelect: (reference: IacsFieldReference) => void }) {
  const draft = usePrivateDraft<ImportDraft>(`iacs-reference-import:${farm.id}`, { country: farm.data.country ?? '', region: '', year: '', format: 'geojson', fileName: '', upstreamName: '', checksum: '', content: '', rights: '', purpose: 'private_reference', coordinatesConfirmed: false, contextConfirmed: false, areaConfirmed: false, previewId: '', retryKey: crypto.randomUUID() });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const value = draft.value;
  function change<K extends keyof ImportDraft>(key: K, next: ImportDraft[K]) { draft.setValue(old => ({ ...old, [key]: next, previewId: '', retryKey: crypto.randomUUID() })); setPreview(null); setSelected(''); }
  useEffect(() => {
    if (!expanded || catalog) return;
    let active = true;
    void api.get<Catalog>('/reference-data/iacs/catalog').then(result => { if (active) { setCatalog(result); setError(''); } }).catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [expanded, catalog]);
  useEffect(() => {
    if (!expanded || !draft.ready || !value.previewId) return;
    let active = true;
    void api.get<Preview>(`/reference-data/iacs/${value.previewId}`).then(result => { if (active) setPreview(result); }).catch(failure => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [expanded, draft.ready, value.previewId]);
  const countryEntries = catalog?.coverage.filter(entry => entry.country === value.country) ?? [];
  const applicable = countryEntries.filter(entry => !value.year || (Number(value.year) >= entry.first_year && Number(value.year) <= entry.last_year));
  async function readFile(file?: File) {
    if (!file) return;
    setError('');
    try {
      if (file.size > (catalog?.max_bytes ?? 512000)) throw new Error('Choose a small subset under 512 KB. Full country archives are not supported here.');
      const content = await file.text();
      draft.setValue(old => ({ ...old, content, fileName: file.name, upstreamName: old.upstreamName || file.name, format: file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'geojson', previewId: '', contextConfirmed: false, coordinatesConfirmed: false, areaConfirmed: false, retryKey: crypto.randomUUID() }));
      setPreview(null); setSelected('');
    } catch (failure) { setError(errorMessage(failure)); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setSelected('');
    try {
      if (!value.content) throw new Error('Choose the small GeoJSON or CSV subset you want to compare.');
      if (!value.coordinatesConfirmed || !value.contextConfirmed || !value.areaConfirmed) throw new Error('Confirm the source context, exported coordinates and hectare units before previewing.');
      const result = await api.post<Preview>('/reference-data/iacs/preview', { farm_id: farm.id, country: value.country, region: value.region.trim() || null, year: Number(value.year), format: value.format, content: value.content,
        upstream_file_name: value.upstreamName.trim(), upstream_file_checksum: value.checksum.trim() || null, source_crs: 'EPSG:4326', source_area_unit: 'ha', rights_basis: value.rights.trim(),
        source_context_confirmed: true, use_purpose: value.purpose }, { idempotencyKey: value.retryKey });
      setPreview(result); draft.setValue(old => ({ ...old, previewId: result.id }));
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }
  return <details className="boundary-iacs-reference" onToggle={event => setExpanded(event.currentTarget.open)}><summary>Advanced: compare a small historical IACS export</summary>
    <p>For advisers or farmers who already have a small export from Europe-LAND harmonised IACS v1.3. This adds a comparison reference only. It does not adopt a parcel as yours, update today's crop or submit a claim.</p>
    {error && <Notice kind="error">{error}</Notice>}{draft.error && <Notice kind="warning">{draft.error}</Notice>}
    {!catalog && expanded && !error && <Notice>Opening the historical reference catalogue…</Notice>}
    {catalog && <><Notice kind="warning">{catalog.license}</Notice><p>{catalog.coverage_meaning} Up to {catalog.max_rows} rows and {(catalog.max_bytes/1000).toLocaleString()} KB per subset. No country archive is downloaded.</p>
      <details><summary>Coverage, source and preparation</summary><p><a href={catalog.url} target="_blank" rel="noreferrer">Dataset record and source terms</a></p><p>{catalog.citation}</p><p>The original files use {catalog.native_crs}. Export a small subset to GeoJSON or CSV in {catalog.accepted_subset_crs} longitude/latitude using a GIS tool first. This importer does not reproject coordinates or read GeoParquet archives.</p><p>Keep original columns: <code>{catalog.mandatory_columns.join(', ')}</code>. CSV may include a <code>geometry_geojson</code> column; a row without geometry supplies metadata only.</p><ul>{catalog.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></details>
      <form onSubmit={submit}><fieldset className="draft-fields" disabled={!draft.ready || busy}><div className="form-grid">
        <Field label="Country of the original subset"><select required value={value.country} onChange={event => { change('country',event.target.value); change('region',''); }}><option value="">Choose a documented country</option>{Array.from(new Set(catalog.coverage.map(entry=>entry.country))).map(code=><option key={code} value={code}>{new Intl.DisplayNames(['en'],{type:'region'}).of(code)??code}</option>)}</select></Field>
        <Field label="Year of the original subset"><input type="number" required min="2007" max="2025" value={value.year} onChange={event=>change('year',event.target.value)}/></Field>
        <Field label="Original region or province, if relevant"><input list={`iacs-regions-${farm.id}`} value={value.region} onChange={event=>change('region',event.target.value)} placeholder="Use the documented region code or province"/><datalist id={`iacs-regions-${farm.id}`}>{countryEntries.filter(entry=>entry.region).map(entry=><option key={entry.region!} value={entry.region!}>{entry.name}</option>)}</datalist></Field>
        <Field label="Small subset file"><input type="file" accept=".geojson,.json,.csv,application/geo+json,application/json,text/csv" onChange={event=>void readFile(event.target.files?.[0])}/></Field>
        <Field label="Subset format"><select value={value.format} onChange={event=>change('format',event.target.value as ImportDraft['format'])}><option value="geojson">GeoJSON</option><option value="csv">CSV</option></select></Field>
        <Field label="Original upstream file name"><input required maxLength={200} value={value.upstreamName} onChange={event=>change('upstreamName',event.target.value)}/></Field>
        <Field label="Published upstream checksum, if available"><input placeholder="sha256:… or md5:…" value={value.checksum} onChange={event=>change('checksum',event.target.value)}/></Field>
        <Field label="Purpose of this preview"><select value={value.purpose} onChange={event=>change('purpose',event.target.value as ImportDraft['purpose'])}><option value="private_reference">Private farm comparison</option><option value="noncommercial_research">Noncommercial research only</option></select></Field>
      </div>{value.fileName && <p role="status">Saved subset: {value.fileName}. Its contents are kept in your private browser draft until previewed.</p>}
      {applicable.map(entry=><Notice key={`${entry.country}:${entry.region??'all'}`} kind="warning"><strong>{entry.name} · documented {entry.first_year}–{entry.last_year}</strong><p>{entry.rights}</p>{entry.limits&&<p>{entry.limits}</p>}{entry.redistribution&&<p>Shared redistribution is restricted; this preview does not grant redistribution rights.</p>}</Notice>)}
      <Field label="Licence and attribution basis for this exact subset"><textarea required minLength={10} maxLength={1000} value={value.rights} onChange={event=>change('rights',event.target.value)} placeholder="Identify the source licence, permitted purpose and attribution you checked."/></Field>
      <label className="boundary-check"><input type="checkbox" checked={value.coordinatesConfirmed} onChange={event=>change('coordinatesConfirmed',event.target.checked)} required/>I checked that this exported subset uses WGS84 longitude/latitude (EPSG:4326), not the original EPSG:3035 metres.</label>
      <label className="boundary-check"><input type="checkbox" checked={value.areaConfirmed} onChange={event=>change('areaConfirmed',event.target.checked)} required/>I checked that source field_size and any crop_area values remain in hectares.</label>
      <label className="boundary-check"><input type="checkbox" checked={value.contextConfirmed} onChange={event=>change('contextConfirmed',event.target.checked)} required/>I checked the original country, region, year, source terms and attribution for this exact subset.</label>
      <Button type="submit" loading={busy} disabled={!value.content}>Preview historical candidates</Button></fieldset></form>
    </>}
    {preview && <section className="card"><h4>Review the historical candidates</h4><p>{preview.data.country}{preview.data.region?` · ${preview.data.region}`:''} · {preview.data.year}. These are source records, not ownership or current crop evidence.</p>{preview.farm_context_changed&&<Notice kind="warning">Your farm context changed after this preview. Check the source context and preview the subset again before selecting a candidate.</Notice>}
      <details><summary>Source limitations and retained provenance</summary><ul>{preview.data.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul><p>Subset SHA-256: <code>{preview.data.provenance.subset_sha256}</code></p><p>Original file: {preview.data.provenance.upstream_file_name}. An upstream checksum supplied by you has not been independently verified.</p><p>{preview.data.provenance.rights_basis_supplied_by_user}</p></details>
      {preview.data.candidates.map((candidate,index)=><article className="sat-scene" key={`${candidate.external_id}:${index}`} style={{borderTop:'1px solid var(--line)',paddingBlock:12}}><p><strong>Reference {candidate.external_id}</strong> · source area {candidate.source_area_ha.toLocaleString()} ha</p><p>Source crop: {candidate.crop_name || 'not supplied'} · crop code {candidate.crop_code}. HCAT reference: <code>{candidate.hcat_code}</code>.</p><p className="muted">{candidate.geometry?'Supplied historical outline available for side-by-side comparison.':'No outline in this row; only source metadata can be compared.'} Source field area may differ from the area planted to that crop.</p>
        <Button variant="secondary" disabled={busy || preview.farm_context_changed || !candidate.field_reference || !candidate.may_use_for_farm_administration} onClick={()=>{if(candidate.field_reference){onSelect(candidate.field_reference);setSelected(`${index}`);}}}>Use only as comparison reference</Button>{selected===`${index}`&&<Notice kind="success">This reference is selected for comparison below. Your actual field outline, crop and ownership have not changed.</Notice>}{!candidate.field_reference&&<Notice kind="warning">These terms do not enable selection into farm-administration references. The research preview remains separate.</Notice>}
      </article>)}
    </section>}
  </details>;
}
