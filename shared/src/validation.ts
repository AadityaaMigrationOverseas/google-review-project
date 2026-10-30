import { COMPLAINT_STATUSES, LIMITS, ROLES, SHORT_CODE_PATTERN } from './constants.js';
import type { ComplaintStatus, Role } from './constants.js';

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export type ValidationResult<T, K extends string> = { ok: true; value: T } | { ok: false; errors: FieldErrors<K> };

export interface ReviewInput {
  rating: number;
  text: string;
  consent: true;
  linkCode: string | null;
}
export type ReviewField = 'rating' | 'text' | 'consent' | 'linkCode';

export interface ComplaintInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  rating: number;
  details: string;
  consent: true;
}
export type ComplaintField = keyof ComplaintInput | 'fullName';

// Control characters except tab/newline; zero-width and bidi overrides that
// are commonly abused to disguise text.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;
const EMAIL_PATTERN =
  /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Normalises free text: NFC, unified newlines, unsafe characters removed, trimmed. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Length in user-perceived characters (code points), not UTF-16 units. */
export function textLength(value: string): number {
  return [...value].length;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function validateRating(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Please choose a star rating.';
  if (value < 1 || value > 5) return 'Rating must be between 1 and 5 stars.';
  return null;
}

export function validateReviewText(value: string): string | null {
  const len = textLength(value);
  if (len < LIMITS.reviewTextMin) return `Please write at least ${LIMITS.reviewTextMin} characters.`;
  if (len > LIMITS.reviewTextMax) return `Please keep your review under ${LIMITS.reviewTextMax} characters.`;
  return null;
}

export function validateName(value: string, label: string): string | null {
  if (value.length === 0) return `Please enter your ${label}.`;
  if (textLength(value) > LIMITS.nameMax) return `${capitalise(label)} is too long.`;
  if (!NAME_PATTERN.test(value)) return `${capitalise(label)} contains unsupported characters.`;
  return null;
}

export function validateFullName(value: string): string | null {
  if (value.length === 0) return 'Please enter your full name.';
  if (textLength(value) > LIMITS.fullNameMax) return 'Full name is too long.';
  if (!NAME_PATTERN.test(value)) return 'Full name contains unsupported characters.';
  return null;
}

export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0]!.slice(0, LIMITS.nameMax), lastName: '—' };
  const firstName = parts[0]!.slice(0, LIMITS.nameMax);
  const lastName = parts.slice(1).join(' ').slice(0, LIMITS.nameMax);
  return { firstName, lastName };
}

export function isValidEmail(value: string): boolean {
  return value.length <= LIMITS.emailMax && EMAIL_PATTERN.test(value);
}

export function validateEmail(value: string): string | null {
  if (value.length === 0) return 'Please enter your email address.';
  if (!isValidEmail(value)) return 'Please enter a valid email address.';
  return null;
}

/** Keeps a leading "+" and digits only, e.g. "+91 98765-43210" -> "+919876543210". */
export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

export function validatePhone(raw: string): string | null {
  if (raw.trim().length === 0) return 'Please enter your phone number.';
  if (/[^\d\s()+.-]/.test(raw)) return 'Phone number may only contain digits, spaces, +, - and ().';
  const digits = raw.replace(/\D/g, '').length;
  if (digits < LIMITS.phoneDigitsMin || digits > LIMITS.phoneDigitsMax) return 'Please enter a valid phone number.';
  return null;
}

export function validateComplaintDetails(value: string): string | null {
  const len = textLength(value);
  if (len < LIMITS.complaintDetailsMin)
    return `Please describe the problem in at least ${LIMITS.complaintDetailsMin} characters.`;
  if (len > LIMITS.complaintDetailsMax)
    return `Please keep the description under ${LIMITS.complaintDetailsMax} characters.`;
  return null;
}

export function isValidShortCode(value: unknown): value is string {
  return typeof value === 'string' && SHORT_CODE_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateReviewInput(raw: unknown): ValidationResult<ReviewInput, ReviewField> {
  if (!isRecord(raw)) return { ok: false, errors: { text: 'Invalid request.' } };
  const errors: FieldErrors<ReviewField> = {};

  const ratingError = validateRating(raw.rating);
  if (ratingError) errors.rating = ratingError;

  const rawText = asString(raw.reviewText) ?? asString(raw.text) ?? '';
  const text = normalizeText(rawText);
  const textError = validateReviewText(text);
  if (textError) errors.text = textError;

  if (raw.consent !== true) errors.consent = 'Please confirm you agree to us storing your feedback.';

  let linkCode: string | null = null;
  if (raw.linkCode !== undefined && raw.linkCode !== null && raw.linkCode !== '') {
    if (isValidShortCode(raw.linkCode)) linkCode = raw.linkCode;
    else errors.linkCode = 'Invalid review link.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { rating: raw.rating as number, text, consent: true, linkCode } };
}

export function validateComplaintInput(raw: unknown): ValidationResult<ComplaintInput, ComplaintField> {
  if (!isRecord(raw)) return { ok: false, errors: { details: 'Invalid request.' } };
  const errors: FieldErrors<ComplaintField> = {};

  const hasFullName = typeof raw.fullName === 'string';
  let firstName = normalizeText(asString(raw.firstName) ?? '');
  let lastName = normalizeText(asString(raw.lastName) ?? '');

  if (hasFullName) {
    const fullName = normalizeText(asString(raw.fullName) ?? '');
    const fnErr = validateFullName(fullName);
    if (fnErr) errors.fullName = fnErr;
    else {
      const split = splitFullName(fullName);
      firstName = split.firstName;
      lastName = split.lastName;
    }
  } else {
    const firstErr = validateName(firstName, 'first name');
    const lastErr = validateName(lastName, 'surname');
    if (firstErr) errors.firstName = firstErr;
    if (lastErr) errors.lastName = lastErr;
  }

  const email = (asString(raw.email) ?? '').trim().toLowerCase();
  const phoneRaw = asString(raw.phone) ?? '';
  const detailsRaw = asString(raw.details) ?? asString(raw.reviewText) ?? asString(raw.text) ?? '';
  const details = normalizeText(detailsRaw);

  const checks: Array<[ComplaintField, string | null]> = [
    ['email', validateEmail(email)],
    ['phone', validatePhone(phoneRaw)],
    ['rating', validateRating(raw.rating)],
    ['details', validateComplaintDetails(details)],
  ];
  for (const [field, message] of checks) if (message) errors[field] = message;

  if (raw.consent !== true) errors.consent = 'Please confirm we may store your complaint and contact you about it.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      firstName,
      lastName,
      email,
      phone: normalizePhone(phoneRaw),
      rating: raw.rating as number,
      details,
      consent: true,
    },
  };
}

export function isComplaintStatus(value: unknown): value is ComplaintStatus {
  return typeof value === 'string' && (COMPLAINT_STATUSES as readonly string[]).includes(value);
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
