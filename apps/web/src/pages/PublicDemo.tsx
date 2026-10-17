import { Link } from 'react-router-dom';
import { useSession } from '../auth';
import './publicDemo.css';

export function PublicDemoPage() {
  const { session } = useSession();
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
      <li><h3>Check your fields with LPIS tools</h3><p>Draw or import an outline, compare references and review changes on the map. Keep the physical field separate from the area you claim for support.</p></li>
      <li><h3>Bring the records you already have</h3><p>Preview imports and details extracted from documents. Check uncertain values and reuse confirmed records instead of entering everything again.</p></li>
      <li><h3>Check before filing. Correct after.</h3><p>Review each answer and the evidence still needed. Keep the actual deadline from your instructions alongside the checks; leave it open when it is not known.</p></li>
    </ol></section>
    <section aria-labelledby="demo-case-title"><h2 id="demo-case-title">Start with a Spanish pasture claim</h2><p>A sheep farmer in Cáceres brings a pasture claim to an adviser. Compare the saved figures, check the source and prepare the correction together.</p>
      <dl className="public-demo-figures"><div><dt>Physical field</dt><dd>6.70 ha</dd></div><div><dt>Supplied maximum</dt><dd>3.02 ha</dd></div><div><dt>Difference to check</dt><dd>3.68 ha</dd></div></dl>
      <p>The saved reference records a 45% pasture coefficient, not a smaller shape to draw. Keep the boundary intact while you check the original claim and the proposed correction.</p>
    </section>
    <details><summary>About the sample and its sources</summary><p>Sample farm; official sending stays with you. The sources explain SIGPAC corrections and pasture coefficients.</p><p><a href="https://doe.juntaex.es/otrosFormatos/html.php?anio=2026&doe=230o&xml=2026060302" target="_blank" rel="noreferrer">Extremadura SIGPAC rules, 2026</a> · <a href="https://www.juntaex.es/w/5698" target="_blank" rel="noreferrer">Official SIGPAC correction service</a></p></details>
    <footer><p>FunkyFarm · Less bureaucracy. More farming.</p><Link to={session ? '/app/home' : '/login'}>Open the farm workspace</Link></footer>
  </main>;
}
