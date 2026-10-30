import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/lib/clock.js';
import { silentLogger } from '../../src/lib/logger.js';
import type { CppSentimentEngine } from '../../src/services/sentiment/cppEngine.js';
import { SentimentService } from '../../src/services/sentiment/sentimentService.js';
import { realEngine, realEngineAvailable } from '../helpers.js';

/**
 * Exercises the actual supplied C++ engine (DistilBERT-SST2 via ONNX Runtime).
 * Skipped only when the binary/model have not been built/provisioned.
 */
describe.skipIf(!realEngineAvailable)('supplied C++ sentiment engine', () => {
  let engine: CppSentimentEngine;
  let service: SentimentService;

  beforeAll(async () => {
    engine = realEngine(2);
    expect(await engine.waitUntilReady(30_000)).toBe(true);
    service = new SentimentService(engine, { neutral: 0.75, uncertain: 0.6 }, systemClock, silentLogger);
  });
  afterAll(() => engine.close());

  it('classifies clearly positive reviews as positive', async () => {
    const r = await service.evaluate('Dr. Shah was wonderful, gentle and kind. I love this clinic!');
    expect(r).toMatchObject({ status: 'analyzed', label: 'positive' });
    expect(r.confidence).toBeGreaterThan(0.95);
  });

  it('classifies clearly negative reviews as negative', async () => {
    const r = await service.evaluate('Terrible experience. Rude staff and I waited two hours in pain.');
    expect(r).toMatchObject({ status: 'analyzed', label: 'negative' });
    expect(r.pPositive).toBeLessThan(0.05);
  });

  it('maps low-confidence predictions to neutral or uncertain, never to a confident class', async () => {
    const r = await service.evaluate('The appointment was on Tuesday at 10am');
    expect(['neutral', 'uncertain']).toContain(r.label);
    expect(r.confidence).toBeLessThan(0.75);
    expect(r.label).toBe(r.confidence! < 0.6 ? 'uncertain' : 'neutral');
  });

  it('skips text with no analysable words', async () => {
    expect(await service.evaluate('😀😀 ★★★★★ !!!')).toMatchObject({ status: 'skipped', error: 'EMPTY' });
  });

  it('handles accents, emoji and control characters safely', async () => {
    const r = await service.evaluate('Très bien!! Excellent café-like waiting room 😀\u0000\ttruly great');
    expect(r.label).toBe('positive');
  });

  it('truncates very long reviews to the model window instead of failing', async () => {
    const r = await engine.analyze('great caring service '.repeat(300));
    expect(r.tokens).toBeLessThanOrEqual(512);
    expect(r.label).toBe('POSITIVE');
  });

  it('never passes review text through a shell', async () => {
    const marker = path.join(tmpdir(), `sdc-injection-${process.pid}`);
    rmSync(marker, { force: true });
    await engine.analyze(`great $(touch ${marker}) \`touch ${marker}\`; touch ${marker} && echo`);
    expect(existsSync(marker)).toBe(false);
  });

  it('meets latency targets for typical reviews (p95 < 150 ms on a warm engine)', async () => {
    const texts = [
      'Very professional and painless root canal. Highly recommend.',
      'The receptionist was friendly but the wait was long.',
      'Clean clinic, modern equipment and a caring dentist.',
      'I was overcharged and nobody explained the bill to me.',
    ];
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      await engine.analyze(texts[i % texts.length]!);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    console.info(`real engine latency: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
    expect(p95).toBeLessThan(150);
  });

  it('serves concurrent requests across workers', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        engine.analyze(i % 2 ? 'Fantastic, friendly team' : 'Awful, painful and rude'),
      ),
    );
    results.forEach((r, i) => expect(r.label).toBe(i % 2 ? 'POSITIVE' : 'NEGATIVE'));
  });
});
