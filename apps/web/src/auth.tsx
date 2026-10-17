import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, errorMessage, setCsrfToken, setWorkspaceId } from './api';
import type { Session } from './types';

interface SessionContextValue {
  session: Session | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  acceptSession: (session: Session) => void;
  switchWorkspace: (id: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);
const WORKSPACE_SELECTION_KEY = 'funkyfarm.workspace-selection.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clearWorkspaceSelection() {
  try { sessionStorage.removeItem(WORKSPACE_SELECTION_KEY); } catch { /* Tab storage is optional. */ }
}

function readWorkspaceSelection(userId: string): string | null {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_SELECTION_KEY);
    if (!raw) return null;
    const selection = raw.length <= 160 ? JSON.parse(raw) : null;
    if (!selection || selection.userId !== userId || !UUID.test(selection.userId) || typeof selection.workspaceId !== 'string' || !UUID.test(selection.workspaceId)) {
      clearWorkspaceSelection();
      return null;
    }
    return selection.workspaceId;
  } catch {
    clearWorkspaceSelection();
    return null;
  }
}

function rememberWorkspaceSelection(next: Session) {
  if (!UUID.test(next.user.id) || !UUID.test(next.workspace.id)) return;
  try {
    // This bounded tab preference contains opaque identifiers only, never credentials.
    sessionStorage.setItem(WORKSPACE_SELECTION_KEY, JSON.stringify({ userId: next.user.id, workspaceId: next.workspace.id }));
  } catch { /* Keep the current session usable when tab storage is unavailable. */ }
}

function stableBrowserSession(next: Session, previous: Session | null): Session {
  // Membership order is not an access change. Keep semantic bindings stable
  // so a successful recheck of the same access cannot remount open forms.
  const { token: _nativeToken, ...browser } = next;
  const workspace = { ...next.workspace,
    farm_ids: next.workspace.farm_ids == null ? null : [...new Set(next.workspace.farm_ids)].sort(),
    permissions: [...new Set(next.workspace.permissions ?? [])].sort(),
  };
  const sameUser = previous && previous.user.id === browser.user.id && previous.user.display_name === browser.user.display_name && previous.user.email === browser.user.email;
  const sameWorkspace = previous && previous.workspace.id === workspace.id && previous.workspace.name === workspace.name && previous.workspace.role === workspace.role && JSON.stringify(previous.workspace.farm_ids) === JSON.stringify(workspace.farm_ids) && JSON.stringify(previous.workspace.permissions) === JSON.stringify(workspace.permissions);
  const value = { ...browser, user: previous && sameUser ? previous.user : browser.user, workspace: previous && sameWorkspace ? previous.workspace : workspace };
  return previous && sameUser && sameWorkspace && previous.csrf_token === value.csrf_token ? previous : value;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const currentSession = useRef<Session | null>(null);
  currentSession.current = session;
  const generation = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const acceptSession = useCallback((next: Session) => {
    const accepted = ++generation.current;
    setCsrfToken(next.csrf_token);
    setWorkspaceId(next.workspace.id);
    void import('./offline').then(({ activateDraftAccount }) => {
      if (accepted === generation.current) activateDraftAccount(`${next.user.id}/${next.workspace.id}`);
    });
    // Native bearer credentials never enter browser persistence or application state.
    const browserSession = stableBrowserSession(next, currentSession.current);
    rememberWorkspaceSelection(next);
    currentSession.current = browserSession;
    setSession(browserSession);
    setLoading(false);
    setError(null);
  }, []);
  const refresh = useCallback(async () => {
    const requested = ++generation.current;
    const current = () => requested === generation.current;
    const existing = currentSession.current;
    if (!existing) setLoading(true);
    setError(null);
    // Reloads discover the cookie account first; quiet refreshes keep the active
    // page and request scope intact while its permissions are revalidated.
    if (!existing) setWorkspaceId(null);
    try {
      const defaultSession = await api.get<Session>('/auth/session');
      if (!current()) return;
      if (existing && (defaultSession.user.id !== existing.user.id || defaultSession.workspace.id !== existing.workspace.id)) throw new ApiError(403, 'session_scope_changed', 'Your farm access changed. Sign in again to open your workspace.');
      const available = await api.get<{ items: Session['workspace'][] }>('/workspaces');
      if (!current()) return;
      const defaultMembership = available.items.find(workspace => workspace.id === defaultSession.workspace.id);
      if (!defaultMembership) throw new ApiError(403, 'membership_revoked', 'Your workspace access is no longer available. Sign in again to choose an available workspace.');
      const savedId = existing ? null : readWorkspaceSelection(defaultSession.user.id);
      const preferred = savedId ? available.items.find(workspace => workspace.id === savedId) : null;
      let next = defaultSession;
      let membership = defaultMembership;
      let unavailable = !!savedId && !preferred;
      if (preferred && preferred.id !== defaultSession.workspace.id) {
        setWorkspaceId(preferred.id);
        try {
          const selected = await api.get<Session>('/auth/session');
          if (!current()) return;
          if (selected.user.id !== defaultSession.user.id || selected.workspace.id !== preferred.id) {
            throw new Error('The selected workspace did not confirm the current account. Please try again.');
          }
          next = selected;
          membership = preferred;
        } catch (failure) {
          if (!current()) return;
          if (!(failure instanceof ApiError && [401, 403, 404].includes(failure.status))) throw failure;
          // Membership can be revoked between the list and session requests.
          setWorkspaceId(null);
          clearWorkspaceSelection();
          const fallback = await api.get<Session>('/auth/session');
          if (!current()) return;
          if (fallback.user.id !== defaultSession.user.id || fallback.workspace.id !== defaultSession.workspace.id) throw new Error('Your account changed. Please sign in again.');
          next = fallback;
          unavailable = true;
        }
      }
      acceptSession({ ...next, workspace: { ...next.workspace, ...membership } });
      if (unavailable) setError('That farm workspace is no longer available. Your default workspace is open instead.');
    } catch (failure) {
      if (!current()) return;
      if (existing && !(failure instanceof ApiError && [401, 403].includes(failure.status))) {
        // A lost connection is not a revocation. Keep this account's visible
        // page/drafts; every mutation still uses normal server authorization.
        setError(errorMessage(failure));
        return;
      }
      setCsrfToken(null);
      setWorkspaceId(null);
      currentSession.current = null;
      setSession(null);
      if (failure instanceof ApiError && failure.status === 401) clearWorkspaceSelection();
      else setError(errorMessage(failure));
    } finally {
      if (current()) setLoading(false);
    }
  }, [acceptSession]);
  const logout = useCallback(async () => {
    const signedOutAccount = currentSession.current;
    const signedOutScope = signedOutAccount ? `${signedOutAccount.user.id}/${signedOutAccount.workspace.id}` : null;
    const requested = ++generation.current;
    await api.post('/auth/logout', {});
    let storageError: string | null = null;
    // A parallel expiry must not skip the successful logout's private cleanup.
    // The scope is captured before the request, never read from a new account.
    if (signedOutScope) {
      try {
        const { purgeAccount } = await import('./offline');
        await purgeAccount(signedOutScope);
      } catch {
        storageError = 'You are signed out. This browser could not remove its encrypted form drafts. Clear this site’s browser storage if you share this device.';
      }
    }
    if (requested !== generation.current) {
      if (storageError && currentSession.current === null) setError(storageError);
      return;
    }
    clearWorkspaceSelection();
    setCsrfToken(null);
    setWorkspaceId(null);
    currentSession.current = null;
    setSession(null);
    setLoading(false);
    setError(storageError);
  }, []);
  useEffect(() => {
    if (!session) return;
    let active = true;
    const userId = session.user.id;
    const selectedId = session.workspace.id;
    const requested = generation.current;
    api.get<{ items: Session['workspace'][] }>('/workspaces').then(result => {
      const membership = result.items.find(workspace => workspace.id === selectedId);
      if (!active || requested !== generation.current) return;
      if (!membership) throw new ApiError(403, 'membership_revoked', 'Your workspace access is no longer available. Sign in again to choose an available workspace.');
      const current = currentSession.current;
      if (current?.user.id === userId && current.workspace.id === selectedId) acceptSession({ ...current, workspace: { ...membership } });
    }).catch(failure => {
      if (!active || requested !== generation.current) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
        generation.current++; setCsrfToken(null); setWorkspaceId(null); currentSession.current = null; setSession(null); setLoading(false);
      }
      setError(errorMessage(failure));
    });
    return () => { active = false; };
  }, [session?.user.id, session?.workspace.id, acceptSession]);
  const switchWorkspace = useCallback(async (id: string) => {
    if (!session || id === session.workspace.id) return;
    const requested = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const available = await api.get<{ items: Session['workspace'][] }>('/workspaces');
      if (requested !== generation.current) return;
      const permitted = available.items.find(workspace => workspace.id === id);
      if (!permitted) throw new Error('This workspace is not available to your account.');
      setWorkspaceId(id);
      const next = await api.get<Session>('/auth/session');
      if (requested !== generation.current) return;
      if (next.user.id !== session.user.id || next.workspace.id !== id) throw new Error('The workspace did not confirm your access.');
      acceptSession({ ...next, workspace: { ...next.workspace, ...permitted } });
    } catch (failure) {
      if (requested !== generation.current) return;
      setWorkspaceId(session.workspace.id);
      setError(errorMessage(failure));
      throw failure;
    } finally { if (requested === generation.current) setLoading(false); }
  }, [session, acceptSession]);
  useEffect(() => {
    void refresh();
    const expire = () => { generation.current++; clearWorkspaceSelection(); setCsrfToken(null); setWorkspaceId(null); currentSession.current = null; setSession(null); setLoading(false); };
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, [refresh]);
  const value = useMemo(() => ({ session, loading, error, refresh, logout, acceptSession, switchWorkspace }), [session, loading, error, refresh, logout, acceptSession, switchWorkspace]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession requires SessionProvider.');
  return context;
}
