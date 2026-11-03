import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config/env.js';
import { silentLogger } from '../../src/lib/logger.js';
import { PasswordHasher, validatePasswordStrength } from '../../src/services/auth/password.js';
import { can, permissionsFor } from '../../src/services/auth/rbac.js';
import { maskEmail, maskPhone } from '../../src/services/complaintService.js';
import { escapeHtml, renderComplaintNotification } from '../../src/services/email/templates.js';
import { FormTokenService } from '../../src/services/security/formTokenService.js';
import { RateLimiter } from '../../src/services/security/rateLimiter.js';
import { GoogleReviewDestinationService } from '../../src/services/google/reviewDestination.js';
import {
  classify,
  hasNonLatinLetter,
  isConsistent,
  isRatingMismatch,
  SentimentService,
} from '../../src/services/sentiment/sentimentService.js';
import { SentimentError, type SentimentAnalyzer } from '../../src/services/sentiment/types.js';
import { FakeClock } from '../helpers.js';

describe('sentiment classification', () => {
  const raw = (label: 'POSITIVE' | 'NEGATIVE', confidence: number) => ({
    label,
    confidence,
    pPositive: label === 'POSITIVE' ? confidence : 1 - confidence,
    tokens: 5,
    engineMicros: 1,
  });

  const T = { neutral: 0.75, uncertain: 0.6 };

  it('maps confident predictions to positive / negative', () => {
    expect(classify(raw('POSITIVE', 0.99), T).label).toBe('positive');
    expect(classify(raw('NEGATIVE', 0.9), T).label).toBe('negative');
  });

  it('maps leaning predictions to neutral and near-coin-flips to uncertain', () => {
    expect(classify(raw('POSITIVE', 0.6), T).label).toBe('neutral');
    expect(classify(raw('NEGATIVE', 0.74), T).label).toBe('neutral');
    expect(classify(raw('POSITIVE', 0.59), T).label).toBe('uncertain');
    expect(classify(raw('NEGATIVE', 0.5), T).label).toBe('uncertain');
  });

  it('validates the engine output and marks inconsistent results as uncertain', () => {
    expect(isConsistent(raw('POSITIVE', 0.9))).toBe(true);
    // Label says POSITIVE but the probability says negative.
    expect(isConsistent({ ...raw('POSITIVE', 0.9), pPositive: 0.1 })).toBe(false);
    expect(classify({ ...raw('POSITIVE', 0.9), pPositive: 0.1 }, T).label).toBe('uncertain');
    // Confidence does not match the winning class probability.
    expect(classify({ ...raw('NEGATIVE', 0.95), pPositive: 0.3 }, T).label).toBe('uncertain');
  });

  it('flags rating/text mismatches', () => {
    expect(isRatingMismatch(5, 'negative')).toBe(true);
    expect(isRatingMismatch(1, 'positive')).toBe(true);
    expect(isRatingMismatch(3, 'negative')).toBe(false);
    expect(isRatingMismatch(5, null)).toBe(false);
  });

  it('treats script the English model cannot read as uncertain, and emoji-only text as skipped', async () => {
    const empty: SentimentAnalyzer = {
      modelId: 'test',
      analyze: () => Promise.reject(new SentimentError('EMPTY')),
      status: () => ({ ready: true, workers: 1, readyWorkers: 1, queued: 0 }),
      close: async () => {},
    };
    const s = new SentimentService(empty, T, new FakeClock(), silentLogger);
    await expect(s.evaluate('डॉक्टर बहुत अच्छे थे')).resolves.toMatchObject({
      status: 'analyzed',
      label: 'uncertain',
    });
    await expect(s.evaluate('ડૉક્ટર ખૂબ સારા હતા')).resolves.toMatchObject({ label: 'uncertain' });
    await expect(s.evaluate('😀😀 ★★★★★')).resolves.toMatchObject({ status: 'skipped', error: 'EMPTY', label: null });
    expect(hasNonLatinLetter('doctor bahut acchi thi')).toBe(false);
    expect(hasNonLatinLetter('doctor बहुत acchi')).toBe(true);
  });

  it('records engine failures instead of throwing', async () => {
    const failing: SentimentAnalyzer = {
      modelId: 'test',
      analyze: () => Promise.reject(new SentimentError('TIMEOUT')),
      status: () => ({ ready: false, workers: 1, readyWorkers: 0, queued: 0 }),
      close: async () => {},
    };
    const s = new SentimentService(failing, T, new FakeClock(), silentLogger);
    await expect(s.evaluate('anything')).resolves.toMatchObject({ status: 'failed', error: 'TIMEOUT', label: null });
    const disabled = new SentimentService(null, T, new FakeClock(), silentLogger);
    await expect(disabled.evaluate('anything')).resolves.toMatchObject({ status: 'skipped', error: 'DISABLED' });
  });
});

describe('GoogleReviewDestinationService', () => {
  it('uses the configured share link and reports what Google does not support', () => {
    const d = new GoogleReviewDestinationService({ reviewUrl: 'https://share.google/OfCXLb8Jj9b9MaHrL' }).get();
    expect(d).toEqual({
      url: 'https://share.google/OfCXLb8Jj9b9MaHrL',
      kind: 'share_link',
      capabilities: { prefill: false, confirmation: false, postOnBehalf: false },
    });
  });

  it('prefers the direct "write a review" deep link when a Place ID is configured', () => {
    const d = new GoogleReviewDestinationService({
      reviewUrl: 'https://share.google/x',
      placeId: 'ChIJj61dQgK6j4AR4GeTYWZsKWw',
    }).get();
    expect(d.kind).toBe('write_review');
    expect(d.url).toBe('https://search.google.com/local/writereview?placeid=ChIJj61dQgK6j4AR4GeTYWZsKWw');
  });

  it('refuses non-Google or non-https destinations (no open redirect)', () => {
    expect(() => new GoogleReviewDestinationService({ reviewUrl: 'https://evil.example/review' })).toThrow();
    expect(() => new GoogleReviewDestinationService({ reviewUrl: 'http://share.google/abc' })).toThrow();
    expect(() => new GoogleReviewDestinationService({ reviewUrl: 'https://x', placeId: 'bad id!' })).toThrow();
  });

  it('auto-upgrades Google URLs containing a placeid parameter to the direct Write a Review modal URL', () => {
    const d = new GoogleReviewDestinationService({
      reviewUrl: 'https://www.google.com/maps/place/?q=place_id&placeid=ChIJj61dQgK6j4AR4GeTYWZsKWw',
    }).get();
    expect(d.kind).toBe('write_review');
    expect(d.url).toBe('https://search.google.com/local/writereview?placeid=ChIJj61dQgK6j4AR4GeTYWZsKWw');
  });
});

describe('FormTokenService', () => {
  const setup = () => {
    const clock = new FakeClock();
    return { clock, svc: new FormTokenService('s'.repeat(40), clock, 2000, 60_000) };
  };

  it('accepts a token once, after the minimum fill time', () => {
    const { clock, svc } = setup();
    const token = svc.issue('review');
    expect(svc.consume(token, 'review')).toBe('too_fast');
    clock.advance(2500);
    expect(svc.consume(token, 'review')).toBeNull();
    expect(svc.consume(token, 'review')).toBe('reused');
  });

  it('rejects expired, tampered and cross-purpose tokens', () => {
    const { clock, svc } = setup();
    const token = svc.issue('review');
    clock.advance(2500);
    expect(svc.consume(token, 'complaint')).toBe('invalid');
    expect(svc.consume(`${token}x`, 'review')).toBe('invalid');
    expect(svc.consume(undefined, 'review')).toBe('invalid');
    clock.advance(60_000);
    expect(svc.consume(token, 'review')).toBe('expired');
  });
});

describe('RateLimiter', () => {
  it('blocks after the limit and resets after the window', () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(clock);
    const rule = { limit: 2, windowMs: 1000 };
    expect(rl.consume('k', rule).allowed).toBe(true);
    expect(rl.consume('k', rule).allowed).toBe(true);
    const blocked = rl.consume('k', rule);
    expect(blocked).toMatchObject({ allowed: false, retryAfterSec: 1 });
    expect(rl.consume('other', rule).allowed).toBe(true);
    clock.advance(1001);
    expect(rl.consume('k', rule).allowed).toBe(true);
  });

  it('bounds memory', () => {
    const rl = new RateLimiter(new FakeClock(), 100);
    for (let i = 0; i < 1000; i++) rl.consume(`k${i}`, { limit: 1, windowMs: 60_000 });
    expect((rl as unknown as { buckets: Map<string, unknown> }).buckets.size).toBeLessThanOrEqual(100);
  });
});

describe('passwords', () => {
  it('hashes with a per-password salt and verifies', async () => {
    const hasher = new PasswordHasher({ N: 2 ** 10, r: 8, p: 1 });
    const a = await hasher.hash('Correct-Horse-9');
    const b = await hasher.hash('Correct-Horse-9');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(await hasher.verify('Correct-Horse-9', a)).toBe(true);
    expect(await hasher.verify('correct-horse-9', a)).toBe(false);
    expect(await hasher.verify('x', 'garbage')).toBe(false);
  });

  it('enforces strength rules', () => {
    expect(validatePasswordStrength('short')).not.toBeNull();
    expect(validatePasswordStrength('alllowercaseletters')).not.toBeNull();
    expect(validatePasswordStrength('Sufficient-Pass-1')).toBeNull();
  });
});

describe('RBAC', () => {
  it('applies least privilege', () => {
    expect(can('staff', 'complaints:read')).toBe(true);
    expect(can('staff', 'complaints:read_pii')).toBe(false);
    expect(can('staff', 'complaints:update')).toBe(false);
    expect(can('manager', 'complaints:read_pii')).toBe(true);
    expect(can('manager', 'users:manage')).toBe(false);
    expect(permissionsFor('admin')).toContain('users:manage');
  });

  it('masks contact details', () => {
    expect(maskEmail('asha.patel@example.com')).toBe('a••••••@example.com');
    expect(maskPhone('+919876543210')).toBe('••••••••••210');
  });
});

describe('email templates', () => {
  const data = {
    reference: 'SDC-ABC12345',
    firstName: '<img src=x onerror=alert(1)>',
    lastName: 'Patel',
    email: 'a@example.com',
    phone: '+911234567',
    rating: 2,
    details: '<script>alert("x")</script> & more',
    createdAt: Date.UTC(2026, 9, 1),
    dashboardUrl: 'https://portal.test/admin#/complaints/1',
    includeDetails: true,
  };

  it('escapes all patient-supplied content in HTML', () => {
    const { html, text, subject } = renderComplaintNotification(data);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more');
    expect(text).toContain('<script>'); // plain text part is not HTML
    expect(subject).toBe('Negative review SDC-ABC12345 – 2/5 stars');
    expect(subject).not.toContain('Patel');
  });

  it('omits patient details when configured', () => {
    const { html, text } = renderComplaintNotification({ ...data, includeDetails: false });
    expect(html).not.toContain('a@example.com');
    expect(text).not.toContain('alert');
  });

  it('escapeHtml covers quotes', () => {
    expect(escapeHtml(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;');
  });
});

describe('configuration', () => {
  it('refuses insecure production configuration', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    try {
      loadConfig({ NODE_ENV: 'production', APP_BASE_URL: 'http://insecure.example', APP_SECRET: 'short' });
    } catch (err) {
      const problems = (err as ConfigError).problems.join('\n');
      expect(problems).toMatch(/APP_BASE_URL must use https/);
      expect(problems).toMatch(/APP_SECRET must be at least 32/);
      expect(problems).toMatch(/SMTP_HOST is required/);
      expect(problems).toMatch(/EMAIL_FROM is required/);
    }
  });

  it('accepts a complete production configuration', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://reviews.stellardentalclinic.com',
      SHORT_LINK_BASE_URL: 'https://stlr.link',
      APP_SECRET: 'x'.repeat(48),
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'apikey',
      SMTP_PASSWORD: 'from-secret-store',
      EMAIL_FROM: 'Stellar Portal <portal@stellardentalclinic.com>',
    });
    expect(c.session.cookieSecure).toBe(true);
    expect(c.session.cookieName).toBe('__Host-sdc_session');
    expect(c.email.complaintNotifyTo).toBe('aaditya@migrationoverseas.com');
    expect(c.googleReviewUrl).toBe('https://search.google.com/local/writereview?placeid=ChIJfXYa4oPPXzkRD1P8S7a9swU');
    expect(c.allowedOrigins).toEqual(['https://reviews.stellardentalclinic.com', 'https://stlr.link']);
  });

  it('validates sentiment thresholds and the Google Place ID', () => {
    expect(() => loadConfig({ SENTIMENT_UNCERTAIN_THRESHOLD: '0.8', SENTIMENT_NEUTRAL_THRESHOLD: '0.75' })).toThrow(
      /must be lower/,
    );
    expect(() => loadConfig({ GOOGLE_PLACE_ID: 'not a place id' })).toThrow(/GOOGLE_PLACE_ID/);
    expect(loadConfig({ GOOGLE_PLACE_ID: 'ChIJj61dQgK6j4AR4GeTYWZsKWw' }).googlePlaceId).toBe(
      'ChIJj61dQgK6j4AR4GeTYWZsKWw',
    );
  });

  it('requires TRUST_PROXY to name proxies rather than count hops', () => {
    expect(() => loadConfig({ TRUST_PROXY: '1' })).toThrow(/not a hop count/);
    expect(loadConfig({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toBe('loopback, 10.0.0.0/8');
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({}).trustProxy).toBe(false);
  });
});
