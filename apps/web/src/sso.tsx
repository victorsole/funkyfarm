import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import { Button } from './components';

export type SsoProvider = { id: string; name: string; allow_local_development?: boolean };

export function useSsoProviders() {
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    api.get<{ providers: SsoProvider[] }>('/auth/sso/providers').then(result => {
      if (active) setProviders(result.providers);
    }).catch(failure => { if (active) { setProviders([]); setError(errorMessage(failure)); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [version]);
  const retry = useCallback(() => setVersion(value => value + 1), []);
  return { providers, loading, error, retry };
}

export async function startSso(provider: SsoProvider, mode: 'login' | 'link', returnTo: string) {
  const result = await api.post<{ redirect_url: string; allow_local_development: boolean }>(`/auth/sso/${encodeURIComponent(provider.id)}/start`, { mode, return_to: ssoReturnPath(returnTo) });
  followSsoRedirect(result.redirect_url, provider.allow_local_development === true && result.allow_local_development === true);
}

export function ssoReturnMessage(search: string): string | null {
  const query = new URLSearchParams(search);
  const messages: Record<string, string> = {
    cancelled: 'The provider sign-in was cancelled. You can try again or use email and password.',
    failed: 'The provider could not complete sign-in. Try again or use email and password.',
    account_exists: 'An account already uses that email. Sign in with your existing method, then link the provider in Settings.',
    account_link_required: 'An account already uses that email. Sign in with your existing method, then link the provider in Settings.',
    invalid_state: 'This sign-in attempt is no longer valid. Start again below.',
    invalid_identity: 'The provider could not verify an account for this sign-in. Choose another method or try again.',
    link_conflict: 'That provider account is already linked elsewhere. Choose another provider account or sign in with your existing method.',
    session_changed: 'Your sign-in changed while linking the provider. Sign in again before trying to link it.',
    provider_unavailable: 'That provider is not available right now. Choose another sign-in method.',
    invalid_response: 'The provider did not complete sign-in. Choose another method or try again.',
    unlinked: 'The provider connection was removed and all sessions were signed out. Sign in again with another linked provider or email and password.',
    unlinked_drafts_retained: 'The provider connection was removed and all sessions were signed out. This browser could not remove its encrypted form drafts. Clear this site’s browser storage if you share this device, then sign in with another method.',
    expired: 'This sign-in attempt expired. Start again below.',
  };
  return messages[query.get('sso_error') ?? ''] ?? messages[query.get('sso') ?? ''] ?? null;
}

export function SsoButtons({ providers, mode = 'signin', busyProvider, disabled, onChoose }: {
  providers: SsoProvider[];
  mode?: 'signin' | 'link';
  busyProvider?: string | null;
  disabled?: boolean;
  onChoose: (provider: SsoProvider) => void;
}) {
  return <div className="stack">{providers.map(provider => <Button key={provider.id} variant="secondary" loading={busyProvider === provider.id} disabled={disabled || Boolean(busyProvider)} onClick={() => onChoose(provider)}>{mode === 'link' ? `Link ${provider.name}` : `Continue with ${provider.name}`}</Button>)}</div>;
}

/** Keep sign-in returns within the app, including a pending consent screen. */
export function ssoReturnPath(path: string): string {
  try {
    const target = new URL(path, window.location.origin);
    if (target.origin !== window.location.origin || !target.pathname.startsWith('/app/')) return '/app/home';
    return target.pathname + target.search + target.hash;
  } catch { return '/app/home'; }
}

/** Provider destinations come from the server; no credentials enter app storage. */
export function followSsoRedirect(destination: string, allowLocalDevelopment = false) {
  const target = new URL(destination, window.location.origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.username || target.password || !(target.protocol === 'https:' || allowLocalDevelopment && target.protocol === 'http:' && local)) {
    throw new Error('This sign-in destination is not available. Use email and password, or contact the site owner.');
  }
  window.location.assign(target.href);
}
