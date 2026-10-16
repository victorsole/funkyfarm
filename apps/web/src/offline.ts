import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { useSession } from './auth';

const DATABASE = 'funkyfarmers-private-drafts-v1';
const encoder = new TextEncoder();
let connection: Promise<IDBDatabase> | undefined;
const queues = new Map<string, Promise<unknown>>();
const blockedAccounts = new Set<string>();
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('funkyfarmers-private-drafts');
if (channel) channel.onmessage = event => {
  if (event.data?.type === 'purge' && typeof event.data.account === 'string') {
    blockedAccounts.add(event.data.account);
    window.dispatchEvent(new CustomEvent('private-drafts-purged', { detail: event.data.account }));
    window.dispatchEvent(new Event('session-expired'));
  }
};

interface KeyEntry { scope: string; key: CryptoKey }
interface DraftEntry { scope: string; name: string; iv: Uint8Array<ArrayBuffer>; encrypted: ArrayBuffer; updated_at: string }

function account(scope: string) {
  if (!scope || !scope.includes('/') || scope.length > 300) throw new Error('A signed-in account and workspace are required for private drafts.');
  return scope.split('/')[0];
}

function validateName(name: string) {
  if (!name || name.length > 500) throw new Error('This draft needs a valid record reference.');
}

function database() {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) throw new Error('Private draft storage is unavailable in this browser. Keep this form open until you save it to the workspace.');
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('keys', { keyPath: 'scope' });
        db.createObjectStore('drafts', { keyPath: ['scope', 'name'] });
      };
      request.onerror = () => { connection = undefined; reject(new Error('The browser could not open private draft storage. Keep this form open until you save it.')); };
      request.onblocked = () => { connection = undefined; reject(new Error('Another open tab is blocking private draft storage. Close older FunkyFarmers tabs and try again.')); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = undefined; };
        resolve(db);
      };
    });
  }
  return connection;
}

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Private draft storage failed.'));
  });
}

function complete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(new Error('The browser could not save the private draft. Storage may be full or blocked. Keep the form open and save to the workspace.'));
  });
}

function serialized<T>(scope: string, operation: () => Promise<T>): Promise<T> {
  const owner = account(scope);
  const previous = queues.get(owner) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async (): Promise<T> => {
    if (navigator.locks) {
      return await new Promise<T>((resolve, reject) => {
        void navigator.locks.request(`funkyfarmers-drafts:${owner}`, async () => {
          try { resolve(await operation()); }
          catch (failure) { reject(failure); }
        }).catch(reject);
      });
    }
    return await operation();
  });
  queues.set(owner, pending);
  void pending.finally(() => { if (queues.get(owner) === pending) queues.delete(owner); }).catch(() => undefined);
  return pending;
}

async function encryptionKey(db: IDBDatabase, scope: string): Promise<CryptoKey> {
  const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const transaction = db.transaction('keys', 'readwrite');
  const finished = complete(transaction);
  const store = transaction.objectStore('keys');
  const existing = await result<KeyEntry | undefined>(store.get(scope));
  const key = existing?.key ?? candidate;
  if (!existing) store.put({ scope, key } satisfies KeyEntry);
  await finished;
  return key;
}

function encodeValue(value: unknown): Uint8Array<ArrayBuffer> {
  // Draft APIs accept form data, never authentication responses or credentials.
  const json = JSON.stringify({ version: 1, value }, (name, item) => {
    if (/^(?:password|passphrase|token|access_token|refresh_token|csrf_token|authorization|cookie|secret)$/i.test(name)) {
      throw new Error('Credentials cannot be kept in a private form draft.');
    }
    return item;
  });
  if (value === undefined || json.length > 2_000_000) throw new Error('This form is too large for private draft storage. Save it directly to the workspace.');
  return encoder.encode(json);
}

export function saveDraft<T>(scope: string, name: string, value: T): Promise<void> {
  validateName(name);
  const plaintext = encodeValue(value);
  return serialized(scope, async () => {
    if (blockedAccounts.has(account(scope))) throw new Error('You signed out in this browser. Sign in again before keeping private drafts.');
    const db = await database();
    const key = await encryptionKey(db, scope);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${scope}\0${name}`) }, key, plaintext);
    const transaction = db.transaction('drafts', 'readwrite');
    const finished = complete(transaction);
    transaction.objectStore('drafts').put({ scope, name, iv, encrypted, updated_at: new Date().toISOString() } satisfies DraftEntry);
    await finished;
  });
}

export function readDraft<T>(scope: string, name: string): Promise<T | null> {
  validateName(name);
  return serialized(scope, async () => {
    const db = await database();
    const transaction = db.transaction(['drafts', 'keys'], 'readonly');
    const finished = complete(transaction);
    const draftRequest = result<DraftEntry | undefined>(transaction.objectStore('drafts').get([scope, name]));
    const keyRequest = result<KeyEntry | undefined>(transaction.objectStore('keys').get(scope));
    const [draft, storedKey] = await Promise.all([draftRequest, keyRequest]);
    await finished;
    if (!draft) return null;
    if (!storedKey) throw new Error('This browser cannot unlock the saved draft. Keep any current changes open and save them to the workspace.');
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: draft.iv, additionalData: encoder.encode(`${scope}\0${name}`) }, storedKey.key, draft.encrypted);
      const payload = JSON.parse(new TextDecoder().decode(plaintext));
      if (payload.version !== 1 || !Object.hasOwn(payload, 'value')) throw new Error('Invalid draft');
      return payload.value as T;
    } catch {
      throw new Error('The saved private draft could not be read. It has been kept in this browser; no server record was changed.');
    }
  });
}

export function deleteDraft(scope: string, name: string): Promise<void> {
  validateName(name);
  return serialized(scope, async () => {
    const db = await database();
    const transaction = db.transaction('drafts', 'readwrite');
    const finished = complete(transaction);
    transaction.objectStore('drafts').delete([scope, name]);
    await finished;
  });
}

// Logout clears this account across all its workspaces on this browser.
export function purgeAccount(scope: string): Promise<void> {
  const owner = account(scope);
  return serialized(scope, async () => {
    const db = await database();
    const transaction = db.transaction(['drafts', 'keys'], 'readwrite');
    const finished = complete(transaction);
    for (const storeName of ['drafts', 'keys']) {
      const cursorRequest = transaction.objectStore(storeName).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (String(cursor.value.scope).startsWith(`${owner}/`)) cursor.delete();
        cursor.continue();
      };
    }
    await finished;
    blockedAccounts.add(owner);
    channel?.postMessage({ type: 'purge', account: owner });
    window.dispatchEvent(new CustomEvent('private-drafts-purged', { detail: owner }));
  });
}

export function activateDraftAccount(scope: string) {
  blockedAccounts.delete(account(scope));
}

export function usePrivateDraft<T>(name: string, initialValue: T) {
  const { session } = useSession();
  const scope = session ? `${session.user.id}/${session.workspace.id}` : null;
  const identity = `${scope ?? ''}\0${name}`;
  const initial = useRef(initialValue);
  initial.current = initialValue;
  const [value, changeValue] = useState<T>(initialValue);
  const valueRef = useRef(value);
  const loaded = useRef<string | null>(null);
  const mounted = useRef(true);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ready = loadedIdentity === identity && scope !== null;

  useEffect(() => {
    let active = true;
    mounted.current = true;
    loaded.current = null;
    setLoadedIdentity(null);
    setError(null);
    setPending(0);
    if (!scope) return () => { active = false; mounted.current = false; };
    readDraft<T>(scope, name).then(saved => {
      if (!active) return;
      const next = saved === null ? initial.current : saved;
      valueRef.current = next;
      changeValue(next);
      loaded.current = identity;
      setLoadedIdentity(identity);
    }).catch(failure => {
      if (!active) return;
      // The form remains usable; all storage failures stay visible to the actor.
      valueRef.current = initial.current;
      changeValue(initial.current);
      loaded.current = identity;
      setLoadedIdentity(identity);
      setError(failure instanceof Error ? failure.message : 'Private draft storage is unavailable. Save changes to the workspace before leaving.');
    });
    return () => { active = false; mounted.current = false; loaded.current = null; };
  }, [identity, scope, name]);

  const setValue = useCallback((update: SetStateAction<T>) => {
    if (!scope || loaded.current !== identity) return;
    const next = typeof update === 'function' ? (update as (previous: T) => T)(valueRef.current) : update;
    valueRef.current = next;
    changeValue(next);
    setPending(count => count + 1);
    // Begin persistence in the input event, so a route change cannot cancel a debounce.
    let persistence: Promise<void>;
    try { persistence = saveDraft(scope, name, next); }
    catch (failure) { persistence = Promise.reject(failure); }
    void persistence.then(() => {
      if (mounted.current && loaded.current === identity) setError(null);
    }).catch(failure => {
      if (mounted.current && loaded.current === identity) setError(failure instanceof Error ? failure.message : 'The private draft could not be saved. Keep this form open.');
    }).finally(() => {
      if (mounted.current && loaded.current === identity) setPending(count => Math.max(0, count - 1));
    });
  }, [identity, scope, name]);

  const clear = useCallback(async () => {
    if (!scope) return;
    try {
      await deleteDraft(scope, name);
      if (mounted.current && loaded.current === identity) {
        valueRef.current = initial.current;
        changeValue(initial.current);
        setError(null);
      }
    } catch (failure) {
      if (mounted.current && loaded.current === identity) setError('The private draft could not be removed from this browser. Check the workspace before saving again.');
    }
  }, [scope, name, identity]);

  return { value, setValue, ready, saving: pending > 0, error, clear };
}
