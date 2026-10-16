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
    setSession(browserSession);
    setError(null);
  }, []);
  const refresh = useCallback(async () => {
    const existing = currentSession.current;
    if (!existing) setLoading(true);
    setError(null);
    try {
      const next = await api.get<Session>('/auth/session');
      if (existing && (next.user.id !== existing.user.id || next.workspace.id !== existing.workspace.id)) {
        throw new Error('Your farm access changed. Sign in again to open your workspace.');
      }
      const available = await api.get<{ items: Session['workspace'][] }>('/workspaces');
      const membership = available.items.find(workspace => workspace.id === next.workspace.id);
      if (!membership) throw new Error('This farm workspace is no longer available to your account.');
      acceptSession({ ...next, workspace: { ...next.workspace, farm_ids: membership.farm_ids, permissions: membership.permissions } });
    } catch (failure) {
      setCsrfToken(null);
      setWorkspaceId(null);
      setSession(null);
      if (!(failure instanceof ApiError && failure.status === 401)) setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [acceptSession]);
  const logout = useCallback(async () => {
    await api.post('/auth/logout', {});
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
      if (next.workspace.id !== id) throw new Error('The workspace did not confirm your access.');
      acceptSession({ ...next, workspace: { ...next.workspace, farm_ids: permitted.farm_ids, permissions: permitted.permissions } });
    } catch (failure) {
      setWorkspaceId(session.workspace.id);
      setError(errorMessage(failure));
      throw failure;
    } finally { setLoading(false); }
  }, [session, acceptSession]);
  useEffect(() => {
    void refresh();
    const expire = () => { setCsrfToken(null); setWorkspaceId(null); setSession(null); };
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
