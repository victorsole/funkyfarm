// Dashboard building blocks, after Bo's GI Dashboard: a tab bar where every tab reaches every
// other, number tiles that open the page managing that number, and findings that each link to
// the place where they get fixed.
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ArrowRight, CircleAlert, CircleCheck, ClipboardList, Inbox, LayoutDashboard, ListChecks, Map as MapIcon, MessagesSquare, TriangleAlert, type LucideIcon } from 'lucide-react';
import './dashboard.css';

export type Role = 'farmer' | 'adviser';
export const roleLabel = (role: string | undefined) => role === 'adviser' ? 'Adviser' : 'Farmer';

type DashTab = { to: string; label: string; icon: LucideIcon; end?: boolean; also?: string[] };
export const farmerTabs: DashTab[] = [
  { to: '/app/home', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/map', label: 'My map', icon: MapIcon },
  { to: '/app/easy-form', label: 'Easy form', icon: ListChecks },
  { to: '/app/paperwork', label: 'Paperwork', icon: ClipboardList, also: ['/app/cases'] },
  { to: '/app/my-adviser', label: 'My adviser', icon: MessagesSquare },
];
export const adviserTabs: DashTab[] = [
  { to: '/app/adviser', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/adviser/map', label: 'Map', icon: MapIcon },
  { to: '/app/adviser/inbox', label: 'Inbox', icon: Inbox },
];

export function dashboardFor(pathname: string, role: Role) {
  const tabs = role === 'adviser' ? adviserTabs : farmerTabs;
  const shown = tabs.some(tab => pathname === tab.to || pathname.startsWith(tab.to + '/') || tab.also?.some(prefix => pathname.startsWith(prefix)));
  return shown ? tabs : null;
}

export function DashboardTabs({ role, tabs }: { role: Role; tabs: DashTab[] }) {
  const bar = useRef<HTMLElement | null>(null);
  const { pathname } = useLocation();
  // On a phone the bar scrolls sideways: keep the current tab in view.
  useEffect(() => { bar.current?.querySelector<HTMLElement>('.dash-tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'center' }); }, [pathname]);
  return <nav ref={bar} className="dash-tabs" aria-label={role === 'adviser' ? 'Adviser dashboard' : 'Farmer dashboard'}>
    <span className="dash-role">{roleLabel(role)}</span>
    {tabs.map(tab => <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => `dash-tab${isActive ? ' is-active' : ''}`}><tab.icon aria-hidden="true"/>{tab.label}</NavLink>)}
  </nav>;
}

export type Tile = { label: string; value: ReactNode; detail?: string; href?: string; tone?: 'farm' | 'gov' | 'eu' | 'alert' | 'ok' | 'help' };
export function StatTiles({ items, label }: { items: Tile[]; label: string }) {
  return <div className="dash-stats" role="list" aria-label={label}>{items.map(item => {
    const body = <><span className="dash-stat-label">{item.label}</span><strong>{item.value}</strong>{item.detail && <small>{item.detail}</small>}</>;
    const style = { '--k': `var(--${item.tone ?? 'farm'})` } as CSSProperties;
    return <div role="listitem" key={item.label}>{item.href ? <Link className="dash-stat" style={style} to={item.href}>{body}<ArrowRight className="dash-stat-go" aria-hidden="true"/></Link> : <div className="dash-stat" style={style}>{body}</div>}</div>;
  })}</div>;
}

export type Finding = { id: string; level: 'conflict' | 'gap' | 'ok'; title: string; detail?: string; href: string; action: string; who?: ReactNode };
const levelIcon = { conflict: CircleAlert, gap: TriangleAlert, ok: CircleCheck };
const levelLabel = { conflict: 'Needs action', gap: 'Missing information', ok: 'Fine' };
export function Findings({ items, empty, loading = false }: { items: Finding[]; empty: ReactNode; loading?: boolean }) {
  if (!items.length) return <p className="dash-empty" role={loading ? 'status' : undefined}>{loading ? <span className="spinner" aria-hidden="true"/> : <CircleCheck aria-hidden="true"/>}{empty}</p>;
  return <ul className="dash-findings">{items.map(item => {
    const Icon = levelIcon[item.level];
    return <li key={item.id} className={`is-${item.level}`}>
      <Icon className="dash-finding-icon" aria-hidden="true"/>
      <div className="dash-finding-text"><span className="dash-finding-level">{levelLabel[item.level]}</span><strong>{item.title}</strong>{item.detail && <span>{item.detail}</span>}{item.who}</div>
      <Link className="dash-finding-go" to={item.href} aria-label={`${item.action}: ${item.title}`}>{item.action}<ArrowRight aria-hidden="true"/></Link>
    </li>;
  })}</ul>;
}
