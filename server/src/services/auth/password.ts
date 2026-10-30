import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

const MAX_MEM = 256 * 1024 * 1024;
const KEY_LENGTH = 64;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export function validatePasswordStrength(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return 'Password is too long.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) return 'Use at least three of: lowercase, uppercase, digits, symbols.';
  return null;
}

export class PasswordHasher {
  private dummyHash: Promise<string> | null = null;

  /** Default cost is the OWASP scrypt baseline (N=2^17, r=8, p=1). */
  constructor(private readonly cost: { N: number; r: number; p: number } = { N: 2 ** 17, r: 8, p: 1 }) {}

  /** Format: scrypt$N$r$p$salt$hash (base64url). */
  async hash(password: string): Promise<string> {
    const { N, r, p } = this.cost;
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEM });
    return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64url');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAX_MEM,
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  }

  /** Spends the same time as a real check so login timing does not reveal which emails exist. */
  async burn(password: string): Promise<void> {
    this.dummyHash ??= this.hash('timing-equaliser-password');
    await this.verify(password, await this.dummyHash);
  }
}
