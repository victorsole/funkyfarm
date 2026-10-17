import { Link } from 'react-router-dom';
import { useSession } from '../auth';
import './publicDemo.css';

export function PublicDemoPage() {
  const { session } = useSession();
  return <main className="public-demo">
    <header><Link to="/" aria-label="Funkyfarmers home"><img src="/assets/funkyfarmers-logo.png" width="1397" height="1126" alt="Funkyfarmers" /></Link><span>Hackathon demo</span></header>
    <section className="public-demo-intro">
      <p className="eyebrow">Parcel maps and CAP paperwork</p>
      <h1>Find the parcel mistake before you file.</h1>
      <p>A sheep farmer in Cáceres brings a pasture claim to an adviser. The field covers 6.70 hectares, but the supplied reference gives a smaller maximum area. Check the figures together, prepare a correction and keep the supporting records.</p>
      <p className="public-demo-fictional">This is a made-up farm and an example reference, not a real application or eligibility decision.</p>
      <dl className="public-demo-figures"><div><dt>Physical field</dt><dd>6.70 ha</dd></div><div><dt>Maximum in the example reference</dt><dd>3.02 ha</dd></div><div><dt>Difference to check</dt><dd>3.68 ha</dd></div></dl>
      <p>The example reference records a 45% pasture coefficient. That does not mean cutting 55% off the map. The field boundary and the area claimed for payment are separate things. Figures shown here are rounded example values.</p>
      <Link className="button button-primary" to={session ? '/app/demo' : '/login?next=%2Fapp%2Fdemo'}>Try the Spain case</Link>
      {!session && <p><Link to="/register?next=%2Fapp%2Fdemo">Create an account for the demo</Link>. The samples go into a separate private workspace.</p>}
    </section>
    <section aria-labelledby="demo-steps-title"><h2 id="demo-steps-title">One case, from map to paperwork</h2><ol className="public-demo-steps">
      <li><h3>Check the parcel</h3><p>See its outline, recorded use and figures. Open the source behind each warning.</p></li>
      <li><h3>Check the proposed correction</h3><p>Review the example records. Keep the original claim separate from what you want to change.</p></li>
      <li><h3>Review the answers</h3><p>Check every reused answer. Missing information and unknown national deadlines stay visible.</p></li>
      <li><h3>Prepare the folder</h3><p>Collect the reviewed changes and evidence. You or your adviser use the official channel; this demo sends nothing.</p></li>
    </ol></section>
    <details><summary>Where this example comes from</summary><p>The farm, reference number and figures are invented. Official guidance keeps parcel boundaries separate from the pasture coefficient. Other conditions or deductions may apply.</p><p><a href="https://doe.juntaex.es/otrosFormatos/html.php?anio=2026&doe=230o&xml=2026060302" target="_blank" rel="noreferrer">Extremadura SIGPAC rules, 2026</a> · <a href="https://www.juntaex.es/w/5698" target="_blank" rel="noreferrer">Official SIGPAC correction service</a></p></details>
    <footer><p>FunkyFarm · Less bureaucracy. More farming.</p><Link to={session ? '/app/home' : '/login'}>Open the farm workspace</Link></footer>
  </main>;
}
