import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { Button, Field, Notice, PageHeader, useRecords, useSession } from '../components';
import type { Page, RecordItem } from '../types';
import { FieldMap, type FieldGeometry, type FieldPoint } from './FieldsMap';

type Parcel = { id: string; name: string; greenhouse?: boolean; geometry?: FieldGeometry; point?: FieldPoint; approximate_area_ha?: number | null };
type Scene = { id: string; datetime: string; platform?: string; cloud_cover: number | null; provider_url: string; assets?: Record<string, unknown> };
type Analysis = { scene_id: string; acquired_at: string; status: string; ndvi_mean: number | null; ndvi_median: number | null; valid_land_pixels: number; total_field_pixels: number; valid_fraction: number; preview_png_base64: string; warnings: string[] };
type SearchData = { farm_id: string; parcel_id: string; field_name: string; provider: string; retrieved_at: string; start_date: string; end_date: string; items: Scene[]; analyses?: Analysis[]; warnings: string[]; has_more?: boolean; interpretation_status: string; imagery_download: string };

export function SatellitePage() {
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
  const field = fields.find(item => item.id === fieldId);
  useEffect(() => { setFarmId(''); setFields([]); setSearches([]); setSelected(null); setFieldId(''); setError(''); setSuccess(''); }, [session?.workspace.id]);
  useEffect(() => {
    let current = true;
    setFields([]); setFieldId(''); setSearches([]); setSelected(null); setError(''); setSuccess('');
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
    setBusy(true); setError(''); setSuccess('');
    try {
      const result = await api.post<RecordItem<SearchData>>('/satellite/search', { farm_id: farmId, parcel_id: fieldId,
        start_date: values.get('start'), end_date: values.get('end'), max_cloud_cover: Number(values.get('cloud')),
        provider: values.get('provider'), limit: 10 }, { idempotencyKey: crypto.randomUUID() });
      retain(result);
      setSuccess(`${result.data.items.length} matching scenes saved to this field. Nothing has been confirmed as farm work.`);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function analyse(sceneId: string) {
    if (!selected) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      const updated = await api.post<RecordItem<SearchData>>(`/satellite/searches/${selected.id}/analyse`, { scene_id: sceneId, expected_revision: selected.revision });
      retain(updated);
      setSuccess('Actual field pixels processed. Review clear-pixel coverage and the retained limitations.');
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
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
    <style>{`.satellite-page .sat-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}.satellite-page .sat-preview{width:100%;max-width:440px;max-height:440px;object-fit:contain;image-rendering:pixelated;background:#e8ece4;border-radius:12px}.satellite-page .sat-scene{border-top:1px solid var(--border,#d9ddd3);padding:20px 0}.satellite-page .sat-history{display:flex;gap:8px;flex-wrap:wrap}.satellite-page .sat-stat{font-size:2rem;font-variant-numeric:tabular-nums}.satellite-page .sat-table{overflow:auto}.satellite-page table{width:100%;border-collapse:collapse}.satellite-page th,.satellite-page td{text-align:left;padding:10px;border-bottom:1px solid #d9ddd3}@media(max-width:760px){.satellite-page .sat-grid{grid-template-columns:1fr}}`}</style>
    <PageHeader title="A view from above" description="Compare real Sentinel-2 scenes with what you know about your field. Images can support a question; you decide what happened." action={<Link className="button button-secondary" to="/app/fields">My fields</Link>} />
    {error && <Notice kind="error">{error}</Notice>}{success && <Notice kind="success">{success}</Notice>}
    {farms.error && <Notice kind="error">{farms.error}</Notice>}
    <section className="card"><div className="sat-grid"><div>
      <Field label="Farm"><select value={farmId} onChange={event => setFarmId(event.target.value)} disabled={busy}><option value="">Choose your farm</option>{farms.items.map(farm => <option key={farm.id} value={farm.id}>{String(farm.data.name)}</option>)}</select></Field>
      {loading && <Notice>Opening your fields and saved searches…</Notice>}
      {farmId && !loading && <Field label="Field"><select value={fieldId} onChange={event => { setFieldId(event.target.value); setSelected(null); setSuccess(''); }} disabled={busy}><option value="">Choose your field</option>{fields.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>}
      {farmId && !loading && !fields.length && <p>Add a field name and its location in <Link to={`/app/fields/${farmId}`}>My fields</Link> first.</p>}
      {field && <><p>{field.approximate_area_ha != null ? `Approximate outline area: ${field.approximate_area_ha.toLocaleString()} ha.` : 'Area unknown; a location point is not a field boundary.'}</p>{field.greenhouse && <Notice kind="warning">This field is under cover. Satellite images do not establish which crop or work is inside the greenhouse. NDVI estimates will be withheld.</Notice>}</>}
    </div><div>{field && <FieldMap geometry={field.geometry} point={field.point} label={field.name} />}</div></div></section>
    {field && <section className="card"><h2>Find images for this field</h2><p>The search sends the supplied field location and dates to the selected public catalogue. It does not send your name, documents or farm accounts.</p>
      <form onSubmit={search}><div className="form-grid"><Field label="From"><input type="date" name="start" required /></Field><Field label="To"><input type="date" name="end" required max={new Date().toISOString().slice(0,10)} /></Field>
        <Field label="Maximum scene cloud cover (%)" hint="This is the whole satellite scene, not your field."><input type="number" name="cloud" min="0" max="100" defaultValue="30" required /></Field>
        <Field label="Public data provider"><select name="provider" defaultValue="earthsearch"><option value="earthsearch">Earth Search · public imagery and metadata</option><option value="copernicus">Copernicus Data Space · metadata</option></select></Field></div>
        <Button type="submit" loading={busy} disabled={!field.geometry && !field.point}>Find satellite scenes</Button></form>
      {!field.geometry && <Notice>With a location point, you can find scenes. Pixel measurements need a reviewed field outline.</Notice>}
    </section>}
    {fieldId && searches.some(item => item.data.parcel_id === fieldId) && <section className="card"><h2>Saved field searches</h2><div className="sat-history">{searches.filter(item => item.data.parcel_id === fieldId).map(item => <Button key={item.id} variant={selected?.id === item.id ? 'primary' : 'secondary'} disabled={busy} onClick={() => { setSelected(item); setOperationScene(''); setSuccess(''); }}>{item.data.start_date} – {item.data.end_date}</Button>)}</div></section>}
    {selected && <section className="card"><PageHeader title={selected.data.field_name} description={`${selected.data.provider} · retrieved ${new Date(selected.data.retrieved_at).toLocaleString()}`} action={<Button variant="secondary" disabled={busy} onClick={() => void download()}>Download metadata</Button>} />
      <details><summary>What these images can and cannot tell you</summary><ul>{selected.data.warnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul><p>{selected.data.imagery_download}</p><p><a href="https://registry.opendata.aws/sentinel-2-l2a-cogs/" target="_blank" rel="noreferrer">Sentinel-2 data source and reuse terms</a></p></details>
      {!selected.data.items.length && <Notice>No matching scenes were returned. This means no match under these search conditions; it does not mean no farming activity occurred.</Notice>}
      {!!selected.data.analyses?.length && <div className="sat-table"><h2>Measured vegetation context</h2><p>Each row uses actual acquired pixels. Different clear pixels, clouds or field boundaries can make dates unsuitable for direct comparison.</p><table><thead><tr><th scope="col">Image date</th><th scope="col">Mean NDVI</th><th scope="col">Clear land pixels</th><th scope="col">Result</th></tr></thead><tbody>{[...selected.data.analyses].sort((a,b) => a.acquired_at.localeCompare(b.acquired_at)).map(analysis => <tr key={analysis.scene_id}><td>{new Date(analysis.acquired_at).toLocaleDateString()}</td><td>{analysis.ndvi_mean ?? 'Withheld'}</td><td>{analysis.valid_land_pixels} / {analysis.total_field_pixels}</td><td>{analysis.status.replaceAll('_',' ')}</td></tr>)}</tbody></table></div>}
      {selected.data.items.map(scene => { const analysis = selected.data.analyses?.find(item => item.scene_id === scene.id); return <article className="sat-scene" key={scene.id}><div className="sat-grid"><div><h3>{new Date(scene.datetime).toLocaleString()}</h3><p>{scene.platform ?? 'Sentinel-2'} · {scene.cloud_cover === null ? 'Scene cloud cover unknown' : `${scene.cloud_cover.toLocaleString()}% scene cloud cover`}</p><p className="muted">{scene.id}</p><div className="actions"><a href={scene.provider_url} target="_blank" rel="noreferrer">Original provider metadata</a>{!analysis && Object.keys(scene.assets ?? {}).length >= 4 && <Button variant="secondary" loading={busy} disabled={!field?.geometry} onClick={() => void analyse(scene.id)}>Read field pixels &amp; preview</Button>}<Button variant="ghost" disabled={busy} onClick={() => setOperationScene(scene.id)}>Describe work I know happened</Button></div>{analysis && <><p className="sat-stat">{analysis.ndvi_mean === null ? 'NDVI withheld' : `NDVI ${analysis.ndvi_mean}`}</p><p>{Math.round(analysis.valid_fraction * 100)}% clear land pixels · {analysis.valid_land_pixels} usable pixels · 10 m image / 20 m quality mask</p><ul>{analysis.warnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul></>}</div><div>{analysis && <figure><img className="sat-preview" src={`data:image/png;base64,${analysis.preview_png_base64}`} alt={`Actual Sentinel-2 true-colour pixels within the supplied ${selected.data.field_name} outline on ${new Date(scene.datetime).toLocaleDateString()}; clouds may be visible.`} /><figcaption className="muted">Acquired true-colour pixels · nearest-pixel display · Copernicus Sentinel data, processed by Earth Search.</figcaption></figure>}</div></div></article>; })}
      {selected.data.has_more && <Notice>Only the first ten matching scenes are shown. Narrow the dates for more targeted evidence.</Notice>}
      {operationScene && <form onSubmit={proposeOperation} className="card"><h2>Describe what you know happened</h2><p>The image date is not the work date. Leave the date blank if you do not know it; this record stays proposed until reviewed.</p><div className="form-grid"><Field label="Work description"><input name="title" required maxLength={300} /></Field><Field label="Type of work"><select name="type"><option value="observation">Field observation</option><option value="mowing">Mowing</option><option value="harvest">Harvest</option><option value="cultivation">Cultivation</option><option value="other">Other work</option></select></Field><Field label="Actual work date, if known"><input name="date" type="date" /></Field><Field label="What supports your description?"><textarea name="note" required minLength={5} maxLength={4000} /></Field></div><div className="actions"><Button type="submit" loading={busy}>Save proposed work</Button><Button variant="ghost" disabled={busy} onClick={() => setOperationScene('')}>Cancel</Button></div></form>}
    </section>}
  </div>;
}
