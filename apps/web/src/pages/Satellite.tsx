import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { Button, Field, Notice, PageHeader, useRecords, useSession } from '../components';
import type { Page, RecordItem } from '../types';
import { FieldMap, type FieldGeometry, type FieldPoint } from './FieldsMap';
import './satellite.css';

type Parcel = { id: string; name: string; greenhouse?: boolean; geometry?: FieldGeometry; point?: FieldPoint; external_id?: string | null; approximate_area_ha?: number | null };
type Scene = { id: string; datetime: string; platform?: string; collection?: string; cloud_cover: number | null; provider_url: string; assets?: Record<string, { href?: string }> };
type Analysis = { scene_id: string; acquired_at: string; status: string; ndvi_mean: number | null; ndvi_median: number | null; valid_land_pixels: number; total_field_pixels: number; valid_fraction: number; preview_png_base64: string; warnings: string[] };
type SearchData = { farm_id: string; parcel_id: string; field_name: string; provider: string; retrieved_at: string; start_date: string; end_date: string; items: Scene[]; analyses?: Analysis[]; warnings: string[]; has_more?: boolean; interpretation_status: string; imagery_download: string };
const resultLabels: Record<string, string> = { measured_context: 'Measured from clear image pixels', greenhouse_not_assessed: 'Not measured under greenhouse cover', insufficient_clear_pixels: 'Not enough clear pixels to measure' };

function hasFieldImage(scene: Scene) {
  return scene.collection === 'sentinel-2-c1-l2a'
    && ['red', 'nir', 'scl', 'visual'].every(band => { const href = scene.assets?.[band]?.href; return typeof href === 'string' && !!href; });
}

function FieldImage({ analysis, fieldName }: { analysis: Analysis; fieldName: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  return <figure className="sat-image">
    {status === 'loading' && <p className="sat-image-placeholder" role="status">Opening your saved field image…</p>}
    {status !== 'failed' && <img className={`sat-preview${status === 'loading' ? ' sat-preview-loading' : ''}`} src={`data:image/png;base64,${analysis.preview_png_base64}`} onLoad={() => setStatus('ready')} onError={() => setStatus('failed')}
      alt={`Satellite image of ${fieldName} on ${new Date(analysis.acquired_at).toLocaleDateString()}; clouds may be visible.`} />}
    {status === 'failed' && <div className="sat-image-placeholder"><p role="alert">This saved image could not open. Your search and records are still saved.</p><Button variant="secondary" onClick={() => setStatus('loading')}>Try opening again</Button></div>}
    <figcaption>Sentinel-2 · {new Date(analysis.acquired_at).toLocaleDateString()} · 10 m pixels. Clouds may cover the field. Copernicus Sentinel data, processed by Earth Search.</figcaption>
  </figure>;
}

export function SatellitePage() {
  const [query] = useSearchParams();
  const suppliedFarm = query.get('farm_id') || '';
  const requestedFarm = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(suppliedFarm) ? suppliedFarm.toLowerCase() : '';
  const farms = useRecords('farms');
  const { session } = useSession();
  const [farmId, setFarmId] = useState('');
  const [fields, setFields] = useState<Parcel[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [searches, setSearches] = useState<RecordItem<SearchData>[]>([]);
  const [selected, setSelected] = useState<RecordItem<SearchData> | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [operationScene, setOperationScene] = useState('');
  const [openingScene, setOpeningScene] = useState('');
  const [imageError, setImageError] = useState<{ sceneId: string; message: string } | null>(null);
  const field = fields.find(item => item.id === fieldId);
  const farm = farms.items.find(item => item.id === farmId);
  useEffect(() => { setFarmId(requestedFarm); setFields([]); setSearches([]); setSelected(null); setFieldId(''); setError(''); setSuccess(''); }, [session?.workspace.id, requestedFarm]);
  useEffect(() => {
    let current = true;
    setFields([]); setFieldId(''); setSearches([]); setSelected(null); setError(''); setSuccess(''); setImageError(null);
    if (!farmId) return;
    setLoading(true);
    void Promise.all([api.get<{ items: Parcel[] }>(`/farms/${farmId}/fields`), api.get<Page<RecordItem<SearchData>>>(`/satellite/searches?farm_id=${encodeURIComponent(farmId)}`)])
      .then(([list, history]) => { if (current) { setFields(list.items); setFieldId(list.items[0]?.id ?? ''); setSearches(history.items); } })
      .catch(err => { if (current) setError(errorMessage(err)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [farmId]);
  function retain(record: RecordItem<SearchData>) { setSelected(record); setSearches(old => [record, ...old.filter(item => item.id !== record.id)]); }
  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true); setError(''); setSuccess(''); setImageError(null);
    try {
      const result = await api.post<RecordItem<SearchData>>('/satellite/search', { farm_id: farmId, parcel_id: fieldId,
        start_date: values.get('start'), end_date: values.get('end'), max_cloud_cover: Number(values.get('cloud')),
        provider: values.get('provider'), limit: 10 }, { idempotencyKey: crypto.randomUUID() });
      retain(result);
      setSuccess(result.data.items.length ? `${result.data.items.length} matching scenes found. ${field?.geometry && result.data.items.some(hasFieldImage) ? 'Choose Open field image below to see one.' : 'Read the scene details below.'}` : 'Search saved. Try a wider date range or allow more cloud cover.');
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function analyse(sceneId: string) {
    if (!selected) return;
    setBusy(true); setOpeningScene(sceneId); setImageError(null); setError(''); setSuccess('');
    try {
      const updated = await api.post<RecordItem<SearchData>>(`/satellite/searches/${selected.id}/analyse`, { scene_id: sceneId, expected_revision: selected.revision });
      retain(updated);
      setSuccess('Field image opened. Check its date and clouds before using it.');
    } catch (err) { setImageError({ sceneId, message: errorMessage(err) }); } finally { setBusy(false); setOpeningScene(''); }
  }
  async function download() {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const blob = await api.download(`/satellite/searches/${selected.id}/metadata`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'field-satellite-metadata.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function proposeOperation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const values = new FormData(event.currentTarget);
    const form = event.currentTarget;
    setBusy(true); setError(''); setSuccess('');
    try {
      await api.post(`/satellite/searches/${selected.id}/operations`, { scene_id: operationScene, title: values.get('title'), type: values.get('type'),
        date: values.get('date') || null, note: values.get('note') }, { idempotencyKey: crypto.randomUUID() });
      setSuccess('Your description was saved as proposed work. Review it in Record work before confirming.');
      form.reset(); setOperationScene('');
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="satellite-page">
    <PageHeader title="A view from above" description="Find satellite images of your field and compare them with your own work records." action={<Link className="button button-secondary" to="/app/fields">My fields</Link>} />
    {error && <Notice kind="error">{error}</Notice>}{success && <Notice kind="success">{success}</Notice>}
    {farms.error && <Notice kind="error">{farms.error}</Notice>}
    <section className="card"><div className="sat-grid"><div>
      <Field label="Farm"><select value={farmId} onChange={event => setFarmId(event.target.value)} disabled={busy}><option value="">Choose your farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{String(farm.data.name)}</option>)}</select></Field>
      {loading && <Notice>Opening your fields and saved searches…</Notice>}
      {farmId && !loading && <Field label="Field"><select value={fieldId} onChange={event => { setFieldId(event.target.value); setSelected(null); setSuccess(''); setImageError(null); }} disabled={busy}><option value="">Choose your field</option>{fields.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>}
      {farmId && !loading && !fields.length && <p>Add a field name and its location in <Link to={`/app/fields/${farmId}`}>My fields</Link> first.</p>}
      {field && <><p>{field.approximate_area_ha != null ? `Approximate outline area: ${field.approximate_area_ha.toLocaleString()} ha.` : 'Area unknown; a location point is not a field boundary.'}</p>{field.greenhouse && <Notice kind="warning">This field is under cover. Satellite images do not establish which crop or work is inside the greenhouse. NDVI estimates will be withheld.</Notice>}</>}
    </div><div>{field && <FieldMap geometry={field.geometry} point={field.point} label={field.name} farm={farm} parcel={field} compact={false} />}</div></div></section>
    {field && <section className="card"><h2>Find images for this field</h2><p>The search sends the supplied field location and dates to the selected public catalogue. It does not send your name, documents or farm accounts.</p>
      <form onSubmit={search}><div className="form-grid"><Field label="From"><input type="date" name="start" required /></Field><Field label="To"><input type="date" name="end" required max={new Date().toISOString().slice(0,10)} /></Field>
        <Field label="Maximum scene cloud cover (%)" hint="This is the whole satellite scene, not your field."><input type="number" name="cloud" min="0" max="100" defaultValue="30" required /></Field>
        <Field label="Public data provider" hint="Choose Earth Search to open a field image. Copernicus lists available scenes only."><select name="provider" defaultValue="earthsearch"><option value="earthsearch">Earth Search · field images</option><option value="copernicus">Copernicus · scene list only</option></select></Field></div>
        <Button type="submit" loading={busy} disabled={!field.geometry && !field.point}>Find satellite scenes</Button></form>
      {!field.geometry && <Notice>With a location point, you can find scenes. Pixel measurements need a reviewed field outline.</Notice>}
    </section>}
    {fieldId && searches.some(item => item.data.parcel_id === fieldId) && <section className="card"><h2>Saved field searches</h2><div className="sat-history">{searches.filter(item => item.data.parcel_id === fieldId).map(item => <Button key={item.id} variant={selected?.id === item.id ? 'primary' : 'secondary'} disabled={busy} onClick={() => { setSelected(item); setOperationScene(''); setSuccess(''); setImageError(null); }}>{item.data.start_date} – {item.data.end_date}</Button>)}</div></section>}
    {selected && <section className="card"><PageHeader title={selected.data.field_name} description={`${selected.data.provider} · retrieved ${new Date(selected.data.retrieved_at).toLocaleString()}`} action={<Button variant="secondary" disabled={busy} onClick={() => void download()}>Download metadata</Button>} />
      <details><summary>What these images can and cannot tell you</summary><ul>{selected.data.warnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul><p>{selected.data.imagery_download}</p><p><a href="https://registry.opendata.aws/sentinel-2-l2a-cogs/" target="_blank" rel="noreferrer">Sentinel-2 data source and reuse terms</a></p></details>
      {!selected.data.items.length && <Notice>No matching scenes were returned. This means no match under these search conditions; it does not mean no farming activity occurred.</Notice>}
      {!!selected.data.analyses?.length && <div className="sat-table"><h2>Greenness measured from the image</h2><p>NDVI measures greenness in the image. Clouds, dates and field boundaries affect the result; it does not prove that a particular farm job was done.</p><table><thead><tr><th scope="col">Image date</th><th scope="col">Greenness index (NDVI)</th><th scope="col">Clear land pixels</th><th scope="col">Result</th></tr></thead><tbody>{[...selected.data.analyses].sort((a,b) => a.acquired_at.localeCompare(b.acquired_at)).map(analysis => <tr key={analysis.scene_id}><td>{new Date(analysis.acquired_at).toLocaleDateString()}</td><td>{analysis.ndvi_mean ?? 'Withheld'}</td><td>{analysis.valid_land_pixels} / {analysis.total_field_pixels}</td><td>{resultLabels[analysis.status] ?? 'Open the image details to check this result'}</td></tr>)}</tbody></table></div>}
      {selected.data.items.map(scene => {
        const analysis = selected.data.analyses?.find(item => item.scene_id === scene.id);
        const available = hasFieldImage(scene);
        const opening = openingScene === scene.id;
        const failed = imageError?.sceneId === scene.id ? imageError.message : '';
        return <article className="sat-scene" key={scene.id} aria-label={`Satellite scene from ${new Date(scene.datetime).toLocaleDateString()}`}>
          <div className="sat-grid"><div>
            <h3>{new Date(scene.datetime).toLocaleString()}</h3>
            <p>{scene.platform ?? 'Sentinel-2'} · {scene.cloud_cover === null ? 'Scene cloud cover unknown' : `${scene.cloud_cover.toLocaleString()}% scene cloud cover`}</p>
            {analysis && <><p className="sat-stat">{analysis.ndvi_mean === null ? 'Greenness not measured' : `Greenness ${analysis.ndvi_mean}`}</p><p>{Math.round(analysis.valid_fraction * 100)}% clear land pixels · {analysis.valid_land_pixels} usable pixels · 10 m image / 20 m quality mask</p><p>{resultLabels[analysis.status] ?? 'Check the image details before using this result.'}</p></>}
            <div className="actions"><a href={scene.provider_url} target="_blank" rel="noreferrer">Read the original image details</a><Button variant="ghost" disabled={busy} onClick={() => setOperationScene(scene.id)}>Describe work I know happened</Button></div>
            {analysis && <details><summary>How this image was checked</summary><ul>{analysis.warnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul></details>}
          </div><div>
            {analysis ? <FieldImage key={`${selected.id}:${scene.id}`} analysis={analysis} fieldName={selected.data.field_name} /> : <div className={`sat-image-placeholder${opening ? ' sat-image-opening' : ''}`} aria-busy={opening}>
              {opening ? <><h4>Opening field image</h4><p role="status">Reading this field from the satellite image. This can take a moment.</p><p>Your other records are unchanged.</p></> : <>
                <h4>{available ? field?.geometry ? 'See your field on this date' : 'Add an outline to open this image' : 'Scene details only'}</h4>
                {failed && <p className="sat-image-error" role="alert">{failed}</p>}
                <p>{available ? field?.geometry ? 'Open just this field, then check the date and any clouds. Other images are not downloaded.' : 'This field has a location pin, but no saved outline. An outline is needed to open its part of the image.' : 'This result lists when an image was taken, but has no field image that can open here. Choose Earth Search above and run a new search.'}</p>
                {available && field?.geometry && <Button disabled={busy} onClick={() => void analyse(scene.id)}>{failed ? 'Try field image again' : 'Open field image'}</Button>}
                {available && !field?.geometry && <Link className="button button-secondary" to={`/app/fields/${farmId}`}>Add a field outline</Link>}
              </>}
            </div>}
          </div></div>
        </article>;
      })}
      {selected.data.has_more && <Notice>Only the first ten matching scenes are shown. Narrow the dates for more targeted evidence.</Notice>}
      {operationScene && <form onSubmit={proposeOperation} className="card"><h2>Describe what you know happened</h2><p>The image date is not the work date. Leave the date blank if you do not know it; this record stays proposed until reviewed.</p><div className="form-grid"><Field label="Work description"><input name="title" required maxLength={300} /></Field><Field label="Type of work"><select name="type"><option value="observation">Field observation</option><option value="mowing">Mowing</option><option value="harvest">Harvest</option><option value="cultivation">Cultivation</option><option value="other">Other work</option></select></Field><Field label="Actual work date, if known"><input name="date" type="date" /></Field><Field label="What supports your description?"><textarea name="note" required minLength={5} maxLength={4000} /></Field></div><div className="actions"><Button type="submit" loading={busy}>Save proposed work</Button><Button variant="ghost" disabled={busy} onClick={() => setOperationScene('')}>Cancel</Button></div></form>}
    </section>}
  </div>;
}
