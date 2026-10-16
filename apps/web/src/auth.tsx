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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const currentSession = useRef<Session | null>(null);
  currentSession.current = session;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const acceptSession = useCallback((next: Session) => {
    setCsrfToken(next.csrf_token);
    setWorkspaceId(next.workspace.id);
    void import('./offline').then(({ activateDraftAccount }) => activateDraftAccount(`${next.user.id}/${next.workspace.id}`));
    // Native bearer credentials never enter browser persistence or application state.
    const { token: _nativeToken, ...browserSession } = next;
    rememberWorkspaceSelection(next);
    currentSession.current = browserSession;
    setSession(browserSession);
    setError(null);
  }, []);
  const refresh = useCallback(async () => {
    const existing = currentSession.current;
    if (!existing) setLoading(true);
    setError(null);
    // Reloads discover the cookie account first; quiet refreshes keep the active
    // page and request scope intact while its permissions are revalidated.
    if (!existing) setWorkspaceId(null);
    try {
      const defaultSession = await api.get<Session>('/auth/session');
      if (existing && (defaultSession.user.id !== existing.user.id || defaultSession.workspace.id !== existing.workspace.id)) throw new Error('Your farm access changed. Sign in again to open your workspace.');
      const available = await api.get<{ items: Session['workspace'][] }>('/workspaces');
      const defaultMembership = available.items.find(workspace => workspace.id === defaultSession.workspace.id);
      if (!defaultMembership) throw new Error('Your default workspace could not be verified. Please try again.');
      const savedId = existing ? null : readWorkspaceSelection(defaultSession.user.id);
      const preferred = savedId ? available.items.find(workspace => workspace.id === savedId) : null;
      let next = defaultSession;
      let membership = defaultMembership;
      let unavailable = !!savedId && !preferred;
      if (preferred && preferred.id !== defaultSession.workspace.id) {
        setWorkspaceId(preferred.id);
        try {
          const selected = await api.get<Session>('/auth/session');
          if (selected.user.id !== defaultSession.user.id || selected.workspace.id !== preferred.id) {
            throw new Error('The selected workspace did not confirm the current account. Please try again.');
          }
          next = selected;
          membership = preferred;
        } catch (failure) {
          if (!(failure instanceof ApiError && [401, 403, 404].includes(failure.status))) throw failure;
          // Membership can be revoked between the list and session requests.
          setWorkspaceId(null);
          clearWorkspaceSelection();
          const fallback = await api.get<Session>('/auth/session');
          if (fallback.user.id !== defaultSession.user.id || fallback.workspace.id !== defaultSession.workspace.id) throw new Error('Your account changed. Please sign in again.');
          next = fallback;
          unavailable = true;
        }
      }
      acceptSession({ ...next, workspace: { ...next.workspace, farm_ids: membership.farm_ids, permissions: membership.permissions } });
      if (unavailable) setError('That farm workspace is no longer available. Your default workspace is open instead.');
    } catch (failure) {
      setCsrfToken(null);
      setWorkspaceId(null);
      currentSession.current = null;
      setSession(null);
      if (failure instanceof ApiError && failure.status === 401) clearWorkspaceSelection();
      else setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [acceptSession]);
  const logout = useCallback(async () => {
    await api.post('/auth/logout', {});
    clearWorkspaceSelection();
    let storageError: string | null = null;
    if (session) {
      try {
        const { purgeAccount } = await import('./offline');
        await purgeAccount(`${session.user.id}/${session.workspace.id}`);
      } catch {
        storageError = 'You are signed out. This browser could not remove its encrypted form drafts. Clear this site’s browser storage if you share this device.';
      }
    }
    setCsrfToken(null);
    setWorkspaceId(null);
    currentSession.current = null;
    setSession(null);
    setError(storageError);
  }, [session]);
  useEffect(() => {
    if (!session) return;
    let active = true;
    const userId = session.user.id;
    const selectedId = session.workspace.id;
    api.get<{ items: Session['workspace'][] }>('/workspaces').then(result => {
      const membership = result.items.find(workspace => workspace.id === selectedId);
      if (!active || !membership) return;
      setSession(current => current?.user.id === userId && current.workspace.id === selectedId
        ? { ...current, workspace: { ...current.workspace, farm_ids: membership.farm_ids, permissions: membership.permissions } }
        : current);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [session?.user.id, session?.workspace.id]);
  const switchWorkspace = useCallback(async (id: string) => {
    if (!session || id === session.workspace.id) return;
    setLoading(true);
    setError(null);
    try {
      const available = await api.get<{ items: Session['workspace'][] }>('/workspaces');
      const permitted = available.items.find(workspace => workspace.id === id);
      if (!permitted) throw new Error('This workspace is not available to your account.');
      setWorkspaceId(id);
      const next = await api.get<Session>('/auth/session');
      if (next.user.id !== session.user.id || next.workspace.id !== id) throw new Error('The workspace did not confirm your access.');
      acceptSession({ ...next, workspace: { ...next.workspace, farm_ids: permitted.farm_ids, permissions: permitted.permissions } });
    } catch (failure) {
      setWorkspaceId(session.workspace.id);
      setError(errorMessage(failure));
      throw failure;
    } finally { setLoading(false); }
  }, [session, acceptSession]);
  useEffect(() => {
    void refresh();
    const expire = () => { clearWorkspaceSelection(); setCsrfToken(null); setWorkspaceId(null); currentSession.current = null; setSession(null); };
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
