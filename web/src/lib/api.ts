import type { ApiError } from '@stellar/shared';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  csrfToken?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const NETWORK_MESSAGE = "We couldn't reach the clinic's server. Please check your connection and try again.";

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.csrfToken) headers['X-CSRF-Token'] = opts.csrfToken;

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError' && opts.signal?.aborted) throw err;
    throw new ApiRequestError(0, 'network', NETWORK_MESSAGE);
  }

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const e = (data ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(
      res.status,
      e.error ?? 'http_error',
      e.message ?? 'Something went wrong. Please try again.',
      (e.fields ?? {}) as Record<string, string>,
    );
  }
  return data as T;
}
