import { Link } from 'react-router-dom';
import { useSession } from '../auth';
import { getSpanishDemoSnapshot } from '../maps/spanishDemo';
import './publicDemo.css';

export function PublicDemoPage() {
  const { session } = useSession();
  const reference = getSpanishDemoSnapshot({ id: 'es-caceres-sigpac-2026-10-17', reference: '10:50:0:0:13:29:1' });
  const entry = (step: 'fields' | 'import' | 'checks') => session ? `/app/demo?step=${step}` : '/login?next=%2Fapp%2Fdemo';
  return <main className="public-demo">
    <header><Link to="/" aria-label="Funkyfarm home"><img className="funkyfarm-logo" src="/assets/funkyfarm-logo.png" width="640" height="571" alt="Funkyfarm" /></Link><span>Demo</span></header>
    <section className="public-demo-intro">
      <p className="eyebrow">Your fields. Your records. Less retyping.</p>
      <h1>Farm paperwork, one clear step at a time.</h1>
      <p>Check your fields, bring in your records and get the next piece of paperwork ready. EasyForm guides you one question at a time.</p>
      <Link className="button button-primary" to={entry('fields')}>Start demo</Link>
      {!session && <p><Link to="/register?next=%2Fapp%2Fdemo">Create an account</Link> to save your progress.</p>}
    </section>
    <section aria-labelledby="demo-steps-title"><h2 id="demo-steps-title">Choose what you want to try</h2><ol className="public-demo-steps">
      <li><h3>Check my fields</h3><p>Compare public parcel outlines with an aerial photo. Spot a boundary mistake and review the correction.</p><Link to={entry('fields')}>Try the field map</Link></li>
      <li><h3>Import my records</h3><p>Bring in a receipt or spreadsheet. Check the extracted details before saving them.</p><Link to={entry('import')}>Try a record import</Link></li>
      <li><h3>Before and after filing</h3><p>Check the answers, see what is missing and prepare a correction when needed.</p><Link to={entry('checks')}>Try the paperwork checks</Link></li>
    </ol></section>
    <section aria-labelledby="demo-case-title"><h2 id="demo-case-title">A real map. A mistake to work through.</h2><p>The Cáceres example uses five public SIGPAC parcels. One private outline fills three holes from the reference. Compare the shapes, save a correction, then choose whether to apply it.</p>
      {reference && <><dl className="public-demo-figures"><div><dt>Reference area</dt><dd>{reference.field.area_ha} ha</dd></div><div><dt>Pasture coefficient</dt><dd>{reference.field.csp_percent}%</dd></div><div><dt>Calculated area</dt><dd>{(reference.field.area_ha * reference.field.csp_percent / 100).toFixed(5)} ha</dd></div></dl><p className="muted">The calculation is not an official maximum or eligibility decision. It does not tell you to draw a smaller boundary.</p><figure className="public-demo-photo"><img src={reference.image.path} width={reference.image.width} height={reference.image.height} alt="Public PNOA aerial photo used for the Cáceres parcel example" loading="lazy"/><figcaption>{reference.image.attribution} · {reference.image.capture_date ? `Capture: ${reference.image.capture_date}` : 'Capture date not provided'}. <a href={reference.image.license_url} target="_blank" rel="noopener noreferrer">Image licence</a></figcaption></figure></>}
    </section>
    <details><summary>Sources and how the demo works</summary><p>Public references, with a staged private claim—not a real holding or proof of ownership. Changes here do not update SIGPAC or send an application.</p>{reference && <p><a href={reference.field.attributes_url} target="_blank" rel="noopener noreferrer">Official parcel details</a> · {reference.source.attribution} · <a href={reference.source.license_url} target="_blank" rel="noopener noreferrer">Parcel data licence</a></p>}<p><a href="https://doe.juntaex.es/otrosFormatos/html.php?anio=2026&doe=230o&xml=2026060302" target="_blank" rel="noreferrer">Extremadura SIGPAC rules, 2026</a> · <a href="https://www.juntaex.es/w/5698" target="_blank" rel="noreferrer">Official SIGPAC correction service</a></p></details>
    <footer><p><b>Funkyfarm</b> · Fields Uploaded, Notified, Kept Yearly</p><Link to={session ? '/app/home' : '/login'}>Open the farm workspace</Link></footer>
  </main>;
}
