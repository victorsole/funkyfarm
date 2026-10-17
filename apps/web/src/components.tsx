import { Children, cloneElement, isValidElement, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { RecordItem } from './types';
export { useRecords } from './hooks';
export { useSession } from './auth';

export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1>{description && <div className="page-description">{description}</div>}</div>{action && <div className="page-action">{action}</div>}</header>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean };
export function Button({ variant = 'primary', loading, children, className = '', disabled, type = 'button', ...props }: ButtonProps) {
  return <button {...props} type={type} className={`button button-${variant} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined}>{loading && <span className="spinner" aria-hidden="true" />}{children}</button>;
}

export function Notice({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'error' | 'success' | 'warning' }) {
  return <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  let inputId = id;
  const content = Children.map(children, child => {
    if (!isValidElement<{ id?: string; 'aria-describedby'?: string }>(child) || typeof child.type !== 'string' || !['input', 'select', 'textarea'].includes(child.type)) return child;
    inputId = child.props.id ?? id;
    return cloneElement(child, { id: inputId, 'aria-describedby': [child.props['aria-describedby'], hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined });
  });
  return <div className="field"><label className="field-label" htmlFor={inputId}>{label}</label>{content}{hint && <small id={`${id}-hint`} className="muted">{hint}</small>}</div>;
}

export function RecordList({ items, basePath, empty = 'No records yet. Add the first one when you are ready.' }: { items: RecordItem[]; basePath: string; empty?: ReactNode }) {
  if (!items.length) return <div className="empty-state"><span className="empty-mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor"><path d="M9 2v14M2 9h14"/></svg></span><p>{empty}</p></div>;
  return <ul className="record-list">{items.map((item, index) => <li key={item.id}><Link to={`${basePath}/${item.id}`}><span className="record-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><div className="record-main"><strong>{String(item.data.title ?? item.data.name ?? item.data.label ?? item.data.filename ?? 'Untitled record')}</strong><span className="muted">{String(item.data.description ?? item.data.recipient ?? item.data.country ?? `Updated ${new Date(item.updated_at).toLocaleDateString()}`)}</span></div>{item.data.status && <span className="badge">{String(item.data.status).replaceAll('_', ' ')}</span>}<svg className="record-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 3 5 5-5 5"/></svg></Link></li>)}</ul>;
}

export function Loading({ children = 'Opening your farm folio…' }: { children?: ReactNode }) {
  return <div className="loading-state" role="status"><span className="spinner" aria-hidden="true" /><p>{children}</p></div>;
}

export function StatusBadge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}
