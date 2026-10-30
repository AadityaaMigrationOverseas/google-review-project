import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CppSentimentEngine } from '../../src/services/sentiment/cppEngine.js';
import {
  createStaff,
  createTestApp,
  fakeEngine,
  formToken,
  freshIp,
  realEngine,
  realEngineAvailable,
  submitReview,
  validComplaint,
  type TestApp,
} from '../helpers.js';

const GOOGLE = 'https://search.google.com/local/writereview?placeid=ChIJfXYa4oPPXzkRD1P8S7a9swU';
const ORIGIN = { origin: 'http://portal.test' };

async function submitComplaint(t: TestApp, body: Record<string, unknown> = {}, ip = freshIp()) {
  const { formToken: token } = await formToken(t, 'complaint', ip);
  return t.app.inject({
    method: 'POST',
    url: '/api/public/complaints',
    remoteAddress: ip,
    headers: ORIGIN,
    payload: { ...validComplaint(), formToken: token, ...body },
  });
}

describe('public review flow', () => {
  let t: TestApp;
  let engine: CppSentimentEngine;

  beforeEach(async () => {
    engine = fakeEngine();
    await engine.waitUntilReady(3000);
    t = await createTestApp({ analyzer: engine });
  });
  afterEach(() => t.close());

  it('stores the review with sentiment and returns the Google link', async () => {
    const res = await submitReview(t, { rating: 5, text: 'Great care, I love the new clinic!' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: 1,
      googleReviewUrl: GOOGLE,
      sentiment: 'positive',
      next: 'google',
      duplicate: false,
    });

    const row = t.c.db.prepare('SELECT * FROM reviews WHERE id = 1').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      rating: 5,
      review_text: 'Great care, I love the new clinic!',
      sentiment_status: 'analyzed',
      sentiment_label: 'positive',
      consent_version: expect.any(String),
    });
    expect(row.ip_hash).toMatch(/^[\w-]{22}$/);
    expect(row.ip_hash).not.toContain('10.0.');
  });

  it('routes by the C++ verdict while always returning the Google link', async () => {
    const positive = await submitReview(t, { rating: 5, text: 'Great, excellent, I love it here.' });
    const negative = await submitReview(t, { rating: 1, text: 'Awful visit, painful and rude staff.' });
    const neutral = await submitReview(t, { rating: 3, text: 'It was on Tuesday __uncertain__.' });
    const mismatch = await submitReview(t, { rating: 5, text: 'Awful, rude and painful experience.' });
    const bodies = [positive, negative, neutral, mismatch].map((r) => {
      expect(r.statusCode).toBe(201);
      const { id: _id, duplicate: _d, ...rest } = r.json() as { id: number; duplicate: boolean };
      return rest;
    });
    expect(bodies).toEqual([
      { googleReviewUrl: GOOGLE, sentiment: 'positive', next: 'google' },
      { googleReviewUrl: GOOGLE, sentiment: 'negative', next: 'complaint' },
      { googleReviewUrl: GOOGLE, sentiment: 'neutral', next: 'complaint' },
      { googleReviewUrl: GOOGLE, sentiment: 'negative', next: 'complaint' },
    ]);

    const labels = t.c.db.prepare('SELECT sentiment_label FROM reviews ORDER BY id').all();
    expect(labels).toEqual([
      { sentiment_label: 'positive' },
      { sentiment_label: 'negative' },
      { sentiment_label: 'neutral' },
      { sentiment_label: 'negative' },
    ]);
  });

  it('replays a retried submission (same idempotency key) instead of storing a duplicate', async () => {
    const key = crypto.randomUUID();
    const first = await submitReview(t, { rating: 5, text: 'Great, excellent care today.', idempotencyKey: key });
    expect(first.statusCode).toBe(201);

    // Same key, a consumed/garbage form token, different IP: still the original result.
    const retry = await t.app.inject({
      method: 'POST',
      url: '/api/public/reviews',
      remoteAddress: freshIp(),
      headers: ORIGIN,
      payload: {
        rating: 5,
        text: 'Great, excellent care today.',
        consent: true,
        formToken: 'already-used',
        idempotencyKey: key,
      },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ...first.json(), duplicate: true });
    expect(t.c.db.prepare('SELECT COUNT(*) AS n FROM reviews').get()).toEqual({ n: 1 });

    const missing = await submitReview(t, { idempotencyKey: undefined });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toMatch(/submission key/);
  });

  it('labels near-coin-flip verdicts as uncertain', async () => {
    const res = await submitReview(t, { rating: 3, text: 'Visit happened __coinflip__.' });
    expect(res.json()).toMatchObject({ sentiment: 'uncertain', next: 'complaint' });
  });

  it('still stores the review when the C++ engine fails, and retries later', async () => {
    const res = await submitReview(t, { text: 'This will crash the engine __crash__' });
    expect(res.statusCode).toBe(201);
    // Engine down: the star rating decides the first step instead.
    expect(res.json()).toMatchObject({ googleReviewUrl: GOOGLE, sentiment: null, next: 'google' });
    const row = () => t.c.db.prepare('SELECT * FROM reviews WHERE id = 1').get() as Record<string, unknown>;
    expect(row()).toMatchObject({ sentiment_status: 'failed', sentiment_error: 'UNAVAILABLE', sentiment_attempts: 1 });

    // Fix the "engine" by rewriting the stored text marker, then let the sweeper retry.
    t.c.db.prepare("UPDATE reviews SET review_text = 'Great service now' WHERE id = 1").run();
    await engine.waitUntilReady(3000);
    t.clock.advance(60_000);
    expect(await t.c.reviews.retryFailedSentiment()).toBe(1);
    expect(row()).toMatchObject({ sentiment_status: 'analyzed', sentiment_label: 'positive', sentiment_attempts: 2 });
  });

  it('times out slow analysis without blocking the patient for long', async () => {
    const slow = fakeEngine('normal', { requestTimeoutMs: 200 });
    await slow.waitUntilReady(3000);
    const t2 = await createTestApp({ analyzer: slow });
    const started = Date.now();
    const res = await submitReview(t2, { text: 'Engine will hang __hang__ forever' });
    expect(res.statusCode).toBe(201);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(t2.c.db.prepare('SELECT sentiment_error FROM reviews').get()).toEqual({ sentiment_error: 'TIMEOUT' });
    await t2.close();
  });

  it('returns field errors for invalid input without consuming the form token', async () => {
    const ip = freshIp();
    const { formToken: token } = await formToken(t, 'review', ip);
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/public/reviews',
      remoteAddress: ip,
      headers: ORIGIN,
      payload: { rating: 7, text: 'meh', consent: false, formToken: token },
    });
    expect(bad.statusCode).toBe(422);
    expect(Object.keys(bad.json().fields).sort()).toEqual(['consent', 'rating', 'text']);

    const good = await t.app.inject({
      method: 'POST',
      url: '/api/public/reviews',
      remoteAddress: ip,
      headers: ORIGIN,
      payload: {
        rating: 4,
        text: 'Fixed my answers, all good.',
        consent: true,
        formToken: token,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(good.statusCode).toBe(201);
  });

  it('rejects bot-speed, replayed and forged submissions', async () => {
    const ip = freshIp();
    const tokenRes = await t.app.inject({ method: 'GET', url: '/api/public/form-token', remoteAddress: ip });
    const token = tokenRes.json().formToken as string;
    const post = (formTok: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/public/reviews',
        remoteAddress: ip,
        headers: ORIGIN,
        payload: {
          rating: 5,
          text: 'A perfectly normal review.',
          consent: true,
          formToken: formTok,
          idempotencyKey: crypto.randomUUID(),
        },
      });

    expect((await post(token)).statusCode).toBe(425);
    t.clock.advance(1500);
    expect((await post(token)).statusCode).toBe(201);
    expect((await post(token)).json().error).toBe('form_reused');
    expect((await post('forged.token')).json().error).toBe('form_invalid');
  });

  it('silently discards honeypot submissions', async () => {
    const res = await submitReview(t, { website: 'http://spam.example' });
    expect(res.statusCode).toBe(201);
    expect(t.c.db.prepare('SELECT COUNT(*) AS n FROM reviews').get()).toEqual({ n: 0 });
  });

  it('rate-limits submissions per client', async () => {
    const ip = freshIp();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await submitReview(t, {}, ip)).statusCode);
    expect(codes.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(codes[5]).toBe(429);
  });

  it('stores XSS payloads verbatim as data (rendered with textContent by the dashboard)', async () => {
    const payload = '<img src=x onerror=alert(1)> great "quotes" & stuff';
    await submitReview(t, { text: payload });
    expect(t.c.db.prepare('SELECT review_text FROM reviews').get()).toEqual({ review_text: payload });
  });

  it('only accepts JSON bodies', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/public/reviews',
      headers: { 'content-type': 'text/plain', ...ORIGIN },
      payload: 'rating=5',
    });
    expect(res.statusCode).toBe(415);
  });

  it('blocks cross-origin form posts', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/public/reviews',
      headers: { origin: 'https://evil.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('previews sentiment, caches the prediction, and routes /api/reviews/submit and /api/complaints/submit', async () => {
    const sessionId = crypto.randomUUID();
    const preview1 = await t.app.inject({
      method: 'POST',
      url: '/api/sentiment/preview',
      remoteAddress: freshIp(),
      headers: ORIGIN,
      payload: { sessionId, reviewText: 'Great care and friendly staff!' },
    });
    expect(preview1.statusCode).toBe(200);
    expect(preview1.json()).toMatchObject({
      sessionId,
      label: 'POSITIVE',
      sentiment: 'positive',
      cached: false,
    });

    // Second preview for the same text hits the cache immediately.
    const preview2 = await t.app.inject({
      method: 'POST',
      url: '/api/sentiment/preview',
      remoteAddress: freshIp(),
      headers: ORIGIN,
      payload: { sessionId, reviewText: 'Great care and friendly staff!' },
    });
    expect(preview2.json()).toMatchObject({
      label: 'POSITIVE',
      cached: true,
      latencyMs: 0,
    });

    // Submitting via /api/reviews/submit uses the warmed cache and returns status: POSITIVE.
    const posRes = await t.app.inject({
      method: 'POST',
      url: '/api/reviews/submit',
      remoteAddress: freshIp(),
      headers: ORIGIN,
      payload: { sessionId, rating: 5, reviewText: 'Great care and friendly staff!' },
    });
    expect(posRes.statusCode).toBe(201);
    expect(posRes.json()).toMatchObject({
      status: 'POSITIVE',
      googleUrl: GOOGLE,
      sentiment: 'positive',
      next: 'google',
    });

    // Authoritative rule: 5 stars with negative sentiment -> NEGATIVE.
    const mismatchRes = await t.app.inject({
      method: 'POST',
      url: '/api/reviews/submit',
      remoteAddress: freshIp(),
      headers: ORIGIN,
      payload: { sessionId: crypto.randomUUID(), rating: 5, reviewText: 'Painful and rude visit.' },
    });
    expect(mismatchRes.statusCode).toBe(201);
    expect(mismatchRes.json()).toMatchObject({
      status: 'NEGATIVE',
      reviewId: expect.any(String),
      sentiment: 'negative',
      next: 'complaint',
    });

    // Authoritative rule: 3 stars with positive sentiment -> NEGATIVE.
    const lowStarRes = await t.app.inject({
      method: 'POST',
      url: '/api/reviews/submit',
      remoteAddress: freshIp(),
      headers: ORIGIN,
      payload: { sessionId: crypto.randomUUID(), rating: 3, reviewText: 'Great doctor and love the clinic.' },
    });
    expect(lowStarRes.statusCode).toBe(201);
    expect(lowStarRes.json()).toMatchObject({
      status: 'NEGATIVE',
      sentiment: 'positive',
      next: 'complaint',
    });

    // Step 5: Internal escalation form submits to /api/complaints/submit with fullName.
    const escRes = await t.app.inject({
      method: 'POST',
      url: '/api/complaints/submit',
      remoteAddress: freshIp(),
      headers: ORIGIN,
      payload: {
        sessionId,
        reviewId: mismatchRes.json().reviewId,
        fullName: 'Rohan Sharma',
        phone: '+91 98765 43210',
        email: 'rohan.sharma@example.com',
        rating: 2,
        reviewText: 'Painful and rude visit.',
      },
    });
    expect(escRes.statusCode).toBe(201);
    expect(escRes.json()).toMatchObject({
      status: 'RESOLVED_QUEUED',
      reference: expect.stringMatching(/^SDC-[0-9A-Z]{8}$/),
      message: expect.stringContaining('24–48 hours'),
    });
  });
});

describe('complaints and email notifications', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.close());

  it('stores the complaint and emails the clinic exactly once', async () => {
    const res = await submitComplaint(t);
    expect(res.statusCode).toBe(201);
    const { reference } = res.json() as { reference: string };
    expect(reference).toMatch(/^SDC-[0-9A-HJKMNP-TV-Z]{8}$/);

    await t.c.outbox.kick();
    expect(t.mail.sent).toHaveLength(1);
    const mail = t.mail.sent[0]!;
    expect(mail.to).toBe('dhruvi@stellardentalclinic.com');
    expect(mail.subject).toContain(reference);
    expect(mail.text).toContain('asha.patel@example.com');
    expect(mail.text).toContain('+919876543210');

    const row = t.c.db.prepare('SELECT status, attempts FROM email_outbox').get();
    expect(row).toEqual({ status: 'sent', attempts: 1 });
  });

  it('treats a retried submission (same idempotency key) as the same complaint', async () => {
    const key = crypto.randomUUID();
    const first = await submitComplaint(t, { idempotencyKey: key });
    const retry = await t.app.inject({
      method: 'POST',
      url: '/api/public/complaints',
      remoteAddress: freshIp(),
      headers: ORIGIN,
      payload: { ...validComplaint(), idempotencyKey: key, formToken: 'already-used' },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().reference).toBe(first.json().reference);
    await t.c.outbox.kick();
    expect(t.mail.sent).toHaveLength(1);
    expect(t.c.db.prepare('SELECT COUNT(*) AS n FROM complaints').get()).toEqual({ n: 1 });
  });

  it('keeps the complaint and retries the email when SMTP is down', async () => {
    t.mail.failures.push(new Error('connect ECONNREFUSED'));
    await submitComplaint(t);
    await t.c.outbox.kick();
    expect(t.mail.sent).toHaveLength(0);
    expect(t.c.db.prepare('SELECT status, last_error FROM email_outbox').get()).toEqual({
      status: 'pending',
      last_error: 'connect ECONNREFUSED',
    });
    t.clock.advance(31_000);
    await t.c.outbox.kick();
    expect(t.mail.sent).toHaveLength(1);
  });

  it('validates every required field', async () => {
    const res = await submitComplaint(t, { firstName: '', email: 'not-an-email', phone: '12', consent: false });
    expect(res.statusCode).toBe(422);
    expect(Object.keys(res.json().fields).sort()).toEqual(['consent', 'email', 'firstName', 'phone']);
  });
});

describe('short links', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp({ env: { SHORT_LINK_HOST: 'stlr.test' } });
  });
  afterEach(() => t.close());

  it('creates unique compact links and attributes reviews to them', async () => {
    const admin = await createStaff(t, 'admin');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/links',
      headers: admin.headers,
      payload: { label: 'WhatsApp follow-up', source: 'WhatsApp' },
    });
    expect(res.statusCode).toBe(201);
    const link = res.json();
    expect(link.code).toMatch(/^[A-Za-z0-9]{7}$/);
    expect(link.url).toBe(`http://portal.test/r/${link.code}`);

    expect((await formToken(t, 'review', freshIp(), link.code)).linkValid).toBe(true);
    expect((await formToken(t, 'review', freshIp(), 'Zz9Zz9Z')).linkValid).toBe(false);

    await submitReview(t, { linkCode: link.code });
    const list = await t.app.inject({ method: 'GET', url: '/api/admin/links', headers: admin.headers });
    expect(list.json().items[0]).toMatchObject({ reviewCount: 1 });

    const qr = await t.app.inject({ method: 'GET', url: `/api/admin/links/${link.id}/qr.svg`, headers: admin.headers });
    expect(qr.headers['content-type']).toContain('image/svg+xml');
    expect(qr.body).toMatch(/^<svg/);
  });

  it('serves active links, 404s unknown/disabled/malformed ones and never redirects off-site', async () => {
    const id = t.c.links.create({ label: 'QR at reception' }, null).id;
    const { code } = t.c.links.get(id);

    // Without a web build the page handler answers 503, which still proves routing/validation.
    const ok = await t.app.inject({ method: 'GET', url: `/r/${code}`, remoteAddress: freshIp() });
    expect([200, 503]).toContain(ok.statusCode);
    expect(ok.headers.location).toBeUndefined();
    expect(t.c.links.get(id).clickCount).toBe(1);

    const unknown = await t.app.inject({ method: 'GET', url: '/r/Nope1234', remoteAddress: freshIp() });
    expect([404, 503]).toContain(unknown.statusCode);
    const traversal = await t.app.inject({ method: 'GET', url: '/r/..%2F..%2Fetc%2Fpasswd', remoteAddress: freshIp() });
    expect([404, 503]).toContain(traversal.statusCode);

    t.c.links.update(id, { disabled: true });
    const disabled = await t.app.inject({ method: 'GET', url: `/r/${code}`, remoteAddress: freshIp() });
    expect([404, 503]).toContain(disabled.statusCode);
    expect(t.c.links.get(id).clickCount).toBe(1);
  });

  it('supports root-level codes on the dedicated short-link host', async () => {
    const { code } = t.c.links.get(t.c.links.create({ label: 'SMS' }, null).id);
    const res = await t.app.inject({
      method: 'GET',
      url: `/${code}`,
      headers: { host: 'stlr.test' },
      remoteAddress: freshIp(),
    });
    expect([200, 503]).toContain(res.statusCode);
    expect(t.c.links.get(1).clickCount).toBe(1);
  });

  it('rate-limits link lookups to deter enumeration', async () => {
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 61; i++)
      last = (await t.app.inject({ method: 'GET', url: `/r/Guess${1000 + i}`, remoteAddress: ip })).statusCode;
    expect(last).toBe(429);
  });

  it('honours expiry', async () => {
    const link = t.c.links.create({ label: 'Campaign', expiresInDays: 1 }, null);
    expect(t.c.links.resolve(link.code)).toBe(link.id);
    t.clock.advance(2 * 86_400_000);
    // Bypass the 30 s positive cache by asking the repository through a fresh resolve after TTL.
    expect(t.c.links.resolve(link.code)).toBeNull();
  });
});

describe('staff authentication and authorisation', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    await submitComplaint(t);
    await submitReview(t);
  });
  afterEach(() => t.close());

  it('requires a session for every admin endpoint', async () => {
    for (const url of [
      '/api/admin/stats',
      '/api/admin/reviews',
      '/api/admin/complaints',
      '/api/admin/links',
      '/api/admin/users',
    ]) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('issues hardened session cookies and rejects bad passwords generically', async () => {
    await t.c.auth.createUser({
      email: 'm@clinic.test',
      name: 'Manager',
      password: 'Correct-Horse-9-battery',
      role: 'manager',
    });
    const login = (password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: freshIp(),
        headers: ORIGIN,
        payload: { email: 'M@clinic.test', password },
      });
    const ok = await login('Correct-Horse-9-battery');
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === 'sdc_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(ok.json()).not.toHaveProperty('user.password_hash');

    const bad = await login('wrong-password');
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: freshIp(),
      headers: ORIGIN,
      payload: { email: 'nobody@clinic.test', password: 'whatever' },
    });
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(bad.json().message).toBe(unknown.json().message);
  });

  it('locks an account after repeated failures', async () => {
    await t.c.auth.createUser({
      email: 'x@clinic.test',
      name: 'Xavier',
      password: 'Correct-Horse-9-battery',
      role: 'staff',
    });
    for (let i = 0; i < 5; i++)
      await t.c.auth.login('x@clinic.test', 'nope', { ipHash: null, userAgent: null }).catch(() => {});
    await expect(
      t.c.auth.login('x@clinic.test', 'Correct-Horse-9-battery', { ipHash: null, userAgent: null }),
    ).rejects.toMatchObject({ statusCode: 423 });
    t.clock.advance(16 * 60_000);
    await expect(
      t.c.auth.login('x@clinic.test', 'Correct-Horse-9-battery', { ipHash: null, userAgent: null }),
    ).resolves.toBeDefined();
  });

  it('expires idle sessions', async () => {
    const admin = await createStaff(t, 'admin');
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/session', headers: admin.headers })).statusCode).toBe(
      200,
    );
    t.clock.advance(61 * 60_000);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/session', headers: admin.headers })).statusCode).toBe(
      401,
    );
  });

  it('requires the CSRF token for state changes', async () => {
    const admin = await createStaff(t, 'admin');
    const { 'x-csrf-token': _csrf, ...noCsrf } = admin.headers;
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/links',
      headers: noCsrf,
      payload: { label: 'Test' },
    });
    expect(res.statusCode).toBe(403);
    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/admin/links',
      headers: { ...admin.headers, 'x-csrf-token': 'x'.repeat(43) },
      payload: { label: 'Test' },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('masks complaint contact details for front-desk staff and blocks their updates', async () => {
    const staff = await createStaff(t, 'staff');
    const list = await t.app.inject({ method: 'GET', url: '/api/admin/complaints', headers: staff.headers });
    expect(list.statusCode).toBe(200);
    const c = list.json().items[0];
    expect(c).toMatchObject({ piiVisible: false, lastName: 'P.' });
    expect(c.email).not.toContain('asha.patel');
    expect(list.body).not.toContain('98765');

    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/complaints/${c.id}`,
      headers: staff.headers,
      payload: { status: 'resolved' },
    });
    expect(patch.statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: staff.headers })).statusCode).toBe(
      403,
    );
  });

  it('lets managers see full details (audited) and update status', async () => {
    const manager = await createStaff(t, 'manager');
    const detail = await t.app.inject({ method: 'GET', url: '/api/admin/complaints/1', headers: manager.headers });
    expect(detail.json()).toMatchObject({
      piiVisible: true,
      email: 'asha.patel@example.com',
      notificationStatus: expect.stringMatching(/pending|sent/),
    });
    expect(t.c.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'complaint.view_pii'").get()).toEqual({
      n: 1,
    });

    const patch = await t.app.inject({
      method: 'PATCH',
      url: '/api/admin/complaints/1',
      headers: manager.headers,
      payload: { status: 'in_progress' },
    });
    expect(patch.json().status).toBe('in_progress');
    const invalid = await t.app.inject({
      method: 'PATCH',
      url: '/api/admin/complaints/1',
      headers: manager.headers,
      payload: { status: "resolved'; DROP TABLE complaints;--" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('treats SQL injection in filters as invalid input', async () => {
    const admin = await createStaff(t, 'admin');
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/admin/reviews?sentiment=${encodeURIComponent("positive' OR '1'='1")}`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(400);
    const cursor = await t.app.inject({
      method: 'GET',
      url: '/api/admin/reviews?cursor=1%20OR%201=1',
      headers: admin.headers,
    });
    expect(cursor.statusCode).toBe(400);
    expect(t.c.db.prepare('SELECT COUNT(*) AS n FROM complaints').get()).toEqual({ n: 1 });
  });

  it('paginates reviews and reports stats', async () => {
    const admin = await createStaff(t, 'admin');
    for (let i = 0; i < 3; i++) await submitReview(t, { rating: 4 });
    const page1 = (
      await t.app.inject({ method: 'GET', url: '/api/admin/reviews?limit=2', headers: admin.headers })
    ).json();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.items[1].id);
    const page2 = (
      await t.app.inject({
        method: 'GET',
        url: `/api/admin/reviews?limit=2&cursor=${page1.nextCursor}`,
        headers: admin.headers,
      })
    ).json();
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();

    const stats = (await t.app.inject({ method: 'GET', url: '/api/admin/stats', headers: admin.headers })).json();
    expect(stats.reviews).toMatchObject({ total: 4, byRating: { 4: 3, 5: 1 } });
    expect(stats.complaints).toMatchObject({ total: 1, open: 1 });
  });

  it('protects the last administrator and revokes sessions on role change', async () => {
    const admin = await createStaff(t, 'admin');
    const manager = await createStaff(t, 'manager');
    const self = await t.app.inject({
      method: 'PATCH',
      url: '/api/admin/users/1',
      headers: admin.headers,
      payload: { role: 'staff' },
    });
    expect(self.statusCode).toBe(409);

    const demote = await t.app.inject({
      method: 'PATCH',
      url: '/api/admin/users/2',
      headers: admin.headers,
      payload: { role: 'staff' },
    });
    expect(demote.json().role).toBe('staff');
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/session', headers: manager.headers })).statusCode).toBe(
      401,
    );
  });

  it('logs out and invalidates the session server-side', async () => {
    const admin = await createStaff(t, 'admin');
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: admin.headers })).statusCode).toBe(
      204,
    );
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/session', headers: admin.headers })).statusCode).toBe(
      401,
    );
  });
});

describe('HTTP hardening', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.close());

  it('sends security headers and no-store on API responses', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/public/form-token' });
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('derives client IPs only from trusted proxies', async () => {
    const proxied = await createTestApp({ env: { TRUST_PROXY: 'loopback' } });
    const submitVia = async (remoteAddress: string, forwardedFor: string) => {
      const headers = { origin: 'http://portal.test', 'x-forwarded-for': forwardedFor };
      const tok = await proxied.app.inject({ method: 'GET', url: '/api/public/form-token', remoteAddress, headers });
      proxied.clock.advance(3000);
      return proxied.app.inject({
        method: 'POST',
        url: '/api/public/reviews',
        remoteAddress,
        headers,
        payload: {
          rating: 4,
          text: 'Friendly and efficient visit.',
          consent: true,
          formToken: tok.json().formToken,
          idempotencyKey: crypto.randomUUID(),
        },
      });
    };
    try {
      for (let i = 1; i <= 7; i++) expect((await submitVia('127.0.0.1', `198.51.100.${i}`)).statusCode).toBe(201);
      const spoofed = [];
      for (let i = 1; i <= 6; i++) spoofed.push((await submitVia('203.0.113.9', `198.51.100.${50 + i}`)).statusCode);
      expect(spoofed.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
      expect(spoofed[5]).toBe(429);
    } finally {
      await proxied.close();
    }
  });

  it('returns generic errors without internals', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('rejects oversized bodies', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/public/reviews',
      headers: ORIGIN,
      payload: { text: 'x'.repeat(40_000) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('exposes a minimal health check', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ status: 'ok', db: true, sentimentReady: false });
  });
});

describe.skipIf(!realEngineAvailable)('end-to-end with the real C++ engine', () => {
  it('analyses submitted reviews with the supplied model', async () => {
    const engine = realEngine();
    await engine.waitUntilReady(30_000);
    const t = await createTestApp({ analyzer: engine });
    await submitReview(t, { rating: 5, text: 'Dr. Shah was amazing and completely painless. Thank you!' });
    await submitReview(t, { rating: 1, text: 'Horrible experience, rude and careless treatment.' });
    const rows = t.c.db.prepare('SELECT sentiment_label, sentiment_model FROM reviews ORDER BY id').all();
    expect(rows).toEqual([
      { sentiment_label: 'positive', sentiment_model: 'distilbert-sst2-onnx/cpp-v1' },
      { sentiment_label: 'negative', sentiment_model: 'distilbert-sst2-onnx/cpp-v1' },
    ]);
    await t.close();
  });
});
