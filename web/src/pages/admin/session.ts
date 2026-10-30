import type { Permission, SessionDto } from '@stellar/shared';
import { api, ApiRequestError, type RequestOptions } from '../../lib/api';

let current: SessionDto | null = null;
const expiredListeners = new Set<() => void>();

export const session = {
  get(): SessionDto | null {
    return current;
  },
  set(s: SessionDto | null): void {
    current = s;
  },
  can(permission: Permission): boolean {
    return current?.permissions.includes(permission) ?? false;
  },
  onExpired(fn: () => void): void {
    expiredListeners.add(fn);
  },
};

/** Staff API call: attaches the CSRF token and returns to sign-in when the session ends. */
export async function adminApi<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  try {
    return await api<T>(path, { ...opts, csrfToken: current?.csrfToken ?? null });
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) {
      current = null;
      for (const fn of expiredListeners) fn();
    }
    throw err;
  }
}
