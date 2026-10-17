import { Link } from 'react-router-dom';
import { PageHeader } from '../components';

type FarmTool = { path: string; title: string; description: string };
const groups: { title: string; items: FarmTool[] }[] = [
  { title: 'Farm records', items: [
    { path: 'fields', title: 'My fields', description: 'Check fields, crops and boundaries.' },
    { path: 'record-work', title: 'Notebook', description: 'Record work, purchases and sales.' },
    { path: 'documents', title: 'Documents', description: 'Keep letters, photos and invoices.' },
    { path: 'imports', title: 'Import records', description: 'Bring in a spreadsheet or an existing file.' },
    { path: 'satellite', title: 'Satellite images', description: 'Look at available images for your fields.' },
  ] },
  { title: 'Paperwork', items: [
    { path: 'easy-form', title: 'Easy form', description: 'Fill in a form, one step at a time.' },
    { path: 'paperwork', title: 'Letters and requests', description: 'Open saved paperwork or add a request.' },
    { path: 'cases', title: 'Corrections and inspections', description: 'Keep the changes and required records together.' },
    { path: 'tasks', title: 'Tasks and questions', description: 'Read questions, save answers and check dates.' },
    { path: 'checks', title: 'Farm checks', description: 'See which requirements need your attention.' },
    { path: 'reports', title: 'Saved forms', description: 'Review and download prepared forms.' },
    { path: 'connections', title: 'Official websites', description: 'Bring in fields or pick up a saved handoff.' },
    { path: 'guidance', title: 'Forms and guidance', description: 'Find the available forms for your country.' },
    { path: 'updates', title: 'Rule updates', description: 'Read the source updates relevant to your farm.' },
    { path: 'funding', title: 'Funding opportunities', description: 'Check calls, dates and the next step for your farm.' },
  ] },
  { title: 'People and help', items: [
    { path: 'adviser', title: 'Adviser view', description: 'Work on the farms that have given you access.' },
    { path: 'community', title: 'Community', description: 'Read posts, share a question or message your adviser.' },
    { path: 'help', title: 'Help', description: 'Get help with the app and its tools.' },
    { path: 'assistant/connect', title: 'Connect an assistant', description: 'Choose what your assistant may access.' },
  ] },
  { title: 'Examples and settings', items: [
    { path: 'demo', title: 'Hackathon demo', description: 'Follow the Spanish field-correction example.' },
    { path: 'examples', title: 'Sample farms', description: 'Try other farm situations with sample records.' },
    { path: 'settings', title: 'Settings', description: 'Manage your account, preferences and access.' },
  ] },
];

export const farmTools = groups.flatMap(group => group.items);

export function ToolsPage() {
  return <>
    <PageHeader title="Farm tools" description="Choose what you need to do." />
    <div className="tools-index">{groups.map(group => <section className="panel" key={group.title}>
      <h2>{group.title}</h2>
      <ul>{group.items.map(tool => <li key={tool.path}><Link to={`/app/${tool.path}`}><strong>{tool.title}</strong><span>{tool.description}</span></Link></li>)}</ul>
    </section>)}</div>
  </>;
}
