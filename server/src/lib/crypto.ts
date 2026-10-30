import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Crockford base32 without I, L, O, U: easy to read aloud over the phone.
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomString(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export const randomBase62 = (length: number): string => randomString(BASE62, length);

export const randomReference = (): string => `SDC-${randomString(REFERENCE_ALPHABET, 8)}`;

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Pseudonymous, non-reversible IP fingerprint for abuse investigation. */
export function hashIp(secret: string, ip: string | undefined): string | null {
  return ip ? hmac(`ip:${secret}`, ip).slice(0, 22) : null;
}
