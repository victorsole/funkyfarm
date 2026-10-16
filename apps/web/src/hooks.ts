import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';
import type { Page, RecordItem } from './types';

export function useRecords<T = Record<string, any>>(kind: string) {
  const [items, setItems] = useState<RecordItem<T>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const requestId = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const loaded: RecordItem<T>[] = [];
      let offset = 0;
      let total = 0;
      do {
        const separator = kind.includes('?') ? '&' : '?';
        const page = await api.get<Page<RecordItem<T>>>(`${kind.startsWith('/') ? '' : '/'}${kind}${separator}limit=100&offset=${offset}`);
        loaded.push(...page.items);
        total = page.total;
        offset += page.items.length;
        if (!page.items.length) break;
      } while (offset < total);
      if (requestId === generation.current) setItems(loaded);
    } catch (failure) {
      if (requestId === generation.current) setError(errorMessage(failure));
    } finally {
      if (requestId === generation.current) setLoading(false);
    }
  }, [kind]);
  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [reload]);
  return { items, loading, error, reload };
}
