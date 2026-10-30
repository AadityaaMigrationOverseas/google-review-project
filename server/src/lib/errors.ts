import type { FieldErrors } from '@stellar/shared';

/** Errors safe to show to clients; anything else is reported as a generic 500. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly fields?: FieldErrors<string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, fields?: FieldErrors<string>) =>
  new AppError(400, 'bad_request', message, fields);
export const validationFailed = (fields: FieldErrors<string>) =>
  new AppError(422, 'validation_failed', 'Please check the highlighted fields.', fields);
export const unauthorized = (message = 'Please sign in.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const tooManyRequests = (retryAfterSec: number) =>
  Object.assign(new AppError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.'), {
    retryAfterSec,
  });
