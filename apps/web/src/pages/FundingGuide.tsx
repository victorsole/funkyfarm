import { Link } from 'react-router-dom';
import { useSession } from '../auth';

export function FundingGuide({ farmId }: { farmId: string }) {
  const { session, loading } = useSession();
  if (loading || !session || !farmId) return null;
  if (Array.isArray(session.workspace.farm_ids) && !session.workspace.farm_ids.includes(farmId)) return null;
  return <section className="card"><h2>Funding and grants</h2><p>Check organisation grants separately from your farm payments, read official updates and keep a follow-up task.</p><Link className="button button-secondary" to={`/app/funding?farm_id=${encodeURIComponent(farmId)}`}>Open funding and grants</Link></section>;
}
