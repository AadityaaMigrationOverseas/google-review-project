import type { FormTokenResponse } from '@stellar/shared';
import { api, ApiRequestError } from './api';

export type FormTokenInfo = FormTokenResponse & { linkValid: boolean | null };

/** Loads a fresh single-use anti-spam token for a public form. */
export function fetchFormToken(purpose: 'review' | 'complaint', linkCode?: string | null): Promise<FormTokenInfo> {
  const params = new URLSearchParams({ purpose });
  if (linkCode) params.set('link', linkCode);
  return api<FormTokenInfo>(`/api/public/form-token?${params}`);
}

const TOKEN_ERRORS = new Set(['form_expired', 'form_invalid', 'form_reused']);

export function isTokenError(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError && TOKEN_ERRORS.has(err.code);
}
