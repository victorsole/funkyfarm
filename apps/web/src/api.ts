const PREFIX = '/api/v1';
let csrfToken: string | null = null;
let workspaceId: string | null = null;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
  }
}

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function setWorkspaceId(id: string | null) { workspaceId = id; }

function endpoint(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('API paths must start with a single slash.');
  return path.startsWith(`${PREFIX}/`) ? path : `${PREFIX}${path}`;
}

type MutationOptions = { idempotencyKey?: string; signal?: AbortSignal };

async function request(path: string, method = 'GET', body?: unknown, options?: MutationOptions): Promise<Response> {
  const headers = new Headers({ Accept: 'application/json' });
  if (workspaceId) headers.set('X-Workspace-ID', workspaceId);
  const upload = body instanceof FormData;
  if (body !== undefined && !upload) headers.set('Content-Type', 'application/json');
  if (method !== 'GET' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  if (options?.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  let response: Response;
  try {
    response = await fetch(endpoint(path), {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers,
      signal: options?.signal,
      body: body === undefined ? undefined : upload ? body : JSON.stringify(body),
    });
  } catch (error) {
    if (options?.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'connection_failed', 'We could not reach the farm workspace. Check your connection and try again.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    if (response.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event('session-expired'));
    }
    throw new ApiError(response.status, payload?.error?.code ?? 'request_failed',
      payload?.error?.message ?? `The workspace could not complete this request (${response.status}).`,
      payload?.error?.details ?? {});
  }
  const actionPath = path.startsWith(`${PREFIX}/`) ? path.slice(PREFIX.length) : path;
  if (method === 'POST' && (actionPath === '/invitations/accept' || /^\/invitations\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/revoke$/i.test(actionPath))) {
    window.dispatchEvent(new Event('workspaces-changed'));
  }
  return response;
}

async function json<T>(path: string, method = 'GET', body?: unknown, options?: MutationOptions): Promise<T> {
  const response = await request(path, method, body, options);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => json<T>(path),
  post: <T>(path: string, body?: unknown, options?: MutationOptions) => json<T>(path, 'POST', body, options),
  patch: <T>(path: string, body: unknown, options?: MutationOptions) => json<T>(path, 'PATCH', body, options),
  upload: <T>(path: string, body: FormData) => json<T>(path, 'POST', body),
  download: async (path: string): Promise<Blob> => (await request(path)).blob(),
  downloadResponse: (path: string, options?: { signal?: AbortSignal }): Promise<Response> => request(path, 'GET', undefined, options),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
