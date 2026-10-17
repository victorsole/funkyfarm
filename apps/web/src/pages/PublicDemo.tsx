import { Link } from 'react-router-dom';
import { useSession } from '../auth';
import { getSpanishDemoSnapshot } from '../maps/spanishDemo';
import './publicDemo.css';

export function PublicDemoPage() {
  const { session } = useSession();
  const reference = getSpanishDemoSnapshot({ id: 'es-caceres-sigpac-2026-10-17', reference: '10:50:0:0:13:29:1' });
  return <main className="public-demo">
    <header><Link to="/" aria-label="Funkyfarmers home"><img src="/assets/funkyfarmers-logo.png" width="1397" height="1126" alt="Funkyfarmers" /></Link><span>Demo</span></header>
    <section className="public-demo-intro">
      <p className="eyebrow">Your fields. Your records. Less retyping.</p>
      <h1>Farm paperwork, one clear step at a time.</h1>
      <p>EasyForm brings the maps, documents and saved records you choose into a guided form. Check the answers, see what is missing and prepare your next step, whether you are getting ready to file or correcting something already sent.</p>
      <Link className="button button-primary" to={session ? '/app/demo' : '/login?next=%2Fapp%2Fdemo'}>Try the Spain case</Link>
      {!session && <p><Link to="/register?next=%2Fapp%2Fdemo">Create an account</Link> to keep your progress in a private workspace.</p>}
    </section>
    <section aria-labelledby="demo-steps-title"><h2 id="demo-steps-title">Three parts of the same job</h2><ol className="public-demo-steps">
      <li><h3>Check your fields with LPIS tools</h3><p>Compare five real public SIGPAC parcels over a retained PNOA photograph. Spot a staged boundary mistake, save a correction and separately review it before applying it to the private record.</p></li>
      <li><h3>Bring the records you already have</h3><p>Preview imports and details extracted from documents. Check uncertain values and reuse confirmed records instead of entering everything again.</p></li>
      <li><h3>Check before filing. Correct after.</h3><p>Review each answer and the evidence still needed. Keep the actual deadline from your instructions alongside the checks; leave it open when it is not known.</p></li>
    </ol></section>
    <section aria-labelledby="demo-case-title"><h2 id="demo-case-title">Real parcels. A staged mistake you can correct.</h2><p>Start with public Cáceres parcel references and a private example claim. D04’s staged outline fills three holes that are present in the retained official geometry. Restore the holes through an actual saved proposal and a separate human review.</p>
      {reference && <><dl className="public-demo-figures"><div><dt>Official reference area</dt><dd>{reference.field.area_ha} ha</dd></div><div><dt>Supplied pasture coefficient</dt><dd>{reference.field.csp_percent}%</dd></div><div><dt>Calculated area at that coefficient</dt><dd>{(reference.field.area_ha * reference.field.csp_percent / 100).toFixed(5)} ha</dd></div></dl><p>The calculated 56.74041 ha is not an officially supplied maximum or an eligibility decision. A coefficient is not a smaller boundary to draw.</p><figure><img src={reference.image.path} width={reference.image.width} height={reference.image.height} alt="Retained PNOA orthophoto used for the Cáceres public-parcel demonstration" loading="lazy" style={{ display: 'block', width: '100%', height: 'auto' }}/><figcaption>{reference.image.attribution} · photograph capture date {reference.image.capture_date || 'not supplied'}. <a href={reference.image.license_url} target="_blank" rel="noopener noreferrer">Image licence</a></figcaption></figure></>}
    </section>
    <details><summary>About the sample and its sources</summary><p>The five public references do not identify a real farmer’s holding or establish ownership. The private claim and mistake are staged; correcting the private record does not update SIGPAC or send an application.</p>{reference && <p><a href={reference.field.attributes_url} target="_blank" rel="noopener noreferrer">Retained parcel’s official source attributes</a> · {reference.source.attribution} · <a href={reference.source.license_url} target="_blank" rel="noopener noreferrer">Parcel data licence</a></p>}<p><a href="https://doe.juntaex.es/otrosFormatos/html.php?anio=2026&doe=230o&xml=2026060302" target="_blank" rel="noreferrer">Extremadura SIGPAC rules, 2026</a> · <a href="https://www.juntaex.es/w/5698" target="_blank" rel="noreferrer">Official SIGPAC correction service</a></p></details>
    <footer><p>FunkyFarm · Less bureaucracy. More farming.</p><Link to={session ? '/app/home' : '/login'}>Open the farm workspace</Link></footer>
  </main>;
}
