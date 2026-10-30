import type { Clock } from '../../lib/clock.js';
import { hmac, randomToken, safeEqual } from '../../lib/crypto.js';

export type FormTokenProblem = 'invalid' | 'too_fast' | 'expired' | 'reused';

/**
 * Signed, single-use tokens issued when a public form loads. They prove the
 * submitter fetched the form, enforce a minimum fill time (bots submit
 * instantly) and stop one token being replayed for bulk submissions.
 */
export class FormTokenService {
  private readonly used = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly clock: Clock,
    private readonly minFillMs: number,
    private readonly ttlMs: number,
  ) {}

  issue(purpose: string): string {
    const payload = `${purpose}.${this.clock.now()}.${randomToken(12)}`;
    return `${Buffer.from(payload).toString('base64url')}.${this.sign(payload)}`;
  }

  /** Validates and consumes the token. Returns null when accepted. */
  consume(token: unknown, purpose: string): FormTokenProblem | null {
    if (typeof token !== 'string' || token.length > 300) return 'invalid';
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) return 'invalid';
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!safeEqual(signature, this.sign(payload))) return 'invalid';

    const [tokenPurpose, issuedRaw] = payload.split('.');
    const issuedAt = Number(issuedRaw);
    if (tokenPurpose !== purpose || !Number.isFinite(issuedAt)) return 'invalid';

    const now = this.clock.now();
    const age = now - issuedAt;
    if (age < this.minFillMs) return 'too_fast';
    if (age > this.ttlMs) return 'expired';

    this.prune(now);
    if (this.used.has(signature)) return 'reused';
    this.used.set(signature, issuedAt + this.ttlMs);
    return null;
  }

  private sign(payload: string): string {
    return hmac(`form:${this.secret}`, payload);
  }

  private prune(now: number): void {
    if (this.used.size < 1000) return;
    for (const [sig, expiresAt] of this.used) if (expiresAt <= now) this.used.delete(sig);
  }
}
