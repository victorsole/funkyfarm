import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import type { Page, RecordItem } from './types';

export function useRecords<T = Record<string, any>>(kind: string) {
  const [state, setState] = useState<{ kind: string; items: RecordItem<T>[]; loaded: boolean; loading: boolean; refreshing: boolean; error: string | null }>(
    { kind, items: [], loaded: false, loading: true, refreshing: false, error: null });
  const generation = useRef(0);
  const currentKind = useRef(kind);
  currentKind.current = kind;
  const reload = useCallback(async () => {
    const requestId = ++generation.current;
    const current = () => requestId === generation.current && currentKind.current === kind;
    setState(previous => previous.kind === kind
      ? { ...previous, loading: !previous.loaded, refreshing: previous.loaded, error: null }
      : { kind, items: [], loaded: false, loading: true, refreshing: false, error: null });
    try {
      const loaded: RecordItem<T>[] = [];
      let offset = 0;
      let total = 0;
      do {
        const separator = kind.includes('?') ? '&' : '?';
        const page = await api.get<Page<RecordItem<T>>>(`${kind.startsWith('/') ? '' : '/'}${kind}${separator}limit=100&offset=${offset}`);
        if (!current()) return;
        loaded.push(...page.items);
        total = page.total;
        offset += page.items.length;
        if (!page.items.length) break;
      } while (offset < total);
      if (current()) setState({ kind, items: loaded, loaded: true, loading: false, refreshing: false, error: null });
    } catch (failure) {
      if (current()) setState(previous => {
        if (previous.kind !== kind) return previous;
        const denied = failure instanceof ApiError && [401, 403, 404].includes(failure.status);
        return { ...previous, ...(denied ? { items: [], loaded: false } : {}), loading: false, refreshing: false, error: errorMessage(failure) };
      });
    }
  }, [kind]);
  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [reload]);
  // Ordinary refreshes leave a loaded page mounted. A changed query/scope must
  // never expose the previous query's records, even before its effect runs.
  const visible = state.kind === kind;
  return { items: visible ? state.items : [], loading: !visible || state.loading,
    refreshing: visible && state.refreshing, error: visible ? state.error : null, reload };
}
