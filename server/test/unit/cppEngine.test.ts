import { afterEach, describe, expect, it } from 'vitest';
import { CppSentimentEngine, toEngineText } from '../../src/services/sentiment/cppEngine.js';
import { SentimentError } from '../../src/services/sentiment/types.js';
import { silentLogger } from '../../src/lib/logger.js';
import { fakeEngine } from '../helpers.js';

const engines: CppSentimentEngine[] = [];
const track = (e: CppSentimentEngine) => (engines.push(e), e);

afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.close()));
});

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof SentimentError && e.code === code);
}

describe('toEngineText', () => {
  it('produces a single ASCII line with accents folded', () => {
    expect(toEngineText('Café\tgreat\r\nservice\u0000 😀 naïve')).toBe('Cafe great service naive');
  });
});

describe('CppSentimentEngine process management', () => {
  it('performs the READY handshake and analyses text', async () => {
    const e = track(fakeEngine());
    expect(await e.waitUntilReady(3000)).toBe(true);
    const r = await e.analyze('I love this clinic');
    expect(r).toMatchObject({ label: 'POSITIVE', confidence: 0.97 });
    expect(e.status()).toMatchObject({ ready: true, workers: 1, readyWorkers: 1 });
  });

  it('serialises concurrent requests and keeps responses matched', async () => {
    const e = track(fakeEngine('normal', { workers: 2, maxQueue: 20 }));
    await e.waitUntilReady(3000);
    const texts = Array.from({ length: 12 }, (_, i) => (i % 2 ? `great visit ${i} __slow__` : `awful visit ${i}`));
    const results = await Promise.all(texts.map((t) => e.analyze(t)));
    results.forEach((r, i) => expect(r.label).toBe(i % 2 ? 'POSITIVE' : 'NEGATIVE'));
  });

  it('times out a hung request, kills the worker and recovers', async () => {
    const e = track(fakeEngine('normal', { requestTimeoutMs: 300 }));
    await e.waitUntilReady(3000);
    await expectCode(e.analyze('this will __hang__'), 'TIMEOUT');
    expect(await e.waitUntilReady(3000)).toBe(true);
    const r = await e.analyze('great after restart');
    // Counter restarts at 1 in the fresh process.
    expect(r.tokens).toBe(1);
  });

  it('reports a crash during analysis and restarts', async () => {
    const e = track(fakeEngine());
    await e.waitUntilReady(3000);
    await expectCode(e.analyze('boom __crash__'), 'UNAVAILABLE');
    await new Promise((r) => setTimeout(r, 120));
    expect(await e.waitUntilReady(3000)).toBe(true);
    await expect(e.analyze('great again')).resolves.toMatchObject({ label: 'POSITIVE' });
  });

  it('rejects malformed output as a protocol error and resyncs', async () => {
    const e = track(fakeEngine());
    await e.waitUntilReady(3000);
    await expectCode(e.analyze('__garbage__'), 'PROTOCOL');
    await expectCode(e.analyze('__err__'), 'INFERENCE');
    await expect(e.analyze('great')).resolves.toMatchObject({ label: 'POSITIVE' });
  });

  it('treats out-of-sequence responses as fatal for that worker', async () => {
    const e = track(fakeEngine());
    await e.waitUntilReady(3000);
    await expectCode(e.analyze('__wrong_id__'), 'PROTOCOL');
    await expect(e.analyze('great')).resolves.toMatchObject({ label: 'POSITIVE', tokens: 1 });
  });

  it('fails fast when the engine cannot start', async () => {
    const e = track(fakeEngine('fatal'));
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await expectCode(e.analyze('hello there'), 'UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('fails when the binary does not exist', async () => {
    const e = track(
      new CppSentimentEngine({
        command: '/nonexistent/sentiment_server',
        args: [],
        workers: 1,
        requestTimeoutMs: 500,
        startupTimeoutMs: 500,
        maxQueue: 5,
        logger: silentLogger,
        restartBaseDelayMs: 1000,
      }),
    );
    e.start();
    await new Promise((r) => setTimeout(r, 100));
    await expectCode(e.analyze('hello there'), 'UNAVAILABLE');
  });

  it('enforces a startup timeout and an invalid handshake', async () => {
    const slow = track(fakeEngine('no-ready', { startupTimeoutMs: 200, requestTimeoutMs: 400 }));
    await expectCode(slow.analyze('hello there'), 'TIMEOUT');
    const bad = track(fakeEngine('bad-handshake', { requestTimeoutMs: 300 }));
    expect(await bad.waitUntilReady(300)).toBe(false);
  });

  it('queues requests made while the engine is still starting', async () => {
    const e = track(fakeEngine('slow-ready'));
    await expect(e.analyze('great')).resolves.toMatchObject({ label: 'POSITIVE' });
  });

  it('applies backpressure when the queue is full', async () => {
    const e = track(fakeEngine('normal', { maxQueue: 2, requestTimeoutMs: 2000 }));
    await e.waitUntilReady(3000);
    const inflight = [e.analyze('one __slow__'), e.analyze('two __slow__'), e.analyze('three __slow__')];
    await expectCode(e.analyze('four'), 'OVERLOADED');
    await Promise.all(inflight);
  });

  it('rejects text with nothing to analyse without calling the engine', async () => {
    const e = track(fakeEngine());
    await expectCode(e.analyze('😀😀 !!! ★★★'), 'EMPTY');
  });

  it('rejects new work after close', async () => {
    const e = fakeEngine();
    await e.waitUntilReady(3000);
    await e.close();
    await expectCode(e.analyze('great'), 'CLOSED');
  });
});
