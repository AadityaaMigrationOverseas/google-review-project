import { LIMITS, normalizeText, textLength, type SentimentLabel, type SentimentPreviewResponse } from '@stellar/shared';
import type { Clock } from '../../lib/clock.js';
import type { Logger } from '../../lib/logger.js';
import type { SentimentUpdate } from '../../repositories/reviewRepository.js';
import { toEngineText } from './cppEngine.js';
import { SentimentError, type RawSentiment, type SentimentAnalyzer } from './types.js';

export interface SentimentThresholds {
  /** Below this confidence the verdict is reported as neutral. */
  neutral: number;
  /** Below this confidence (or when the engine output is inconsistent) the verdict is uncertain. */
  uncertain: number;
}

/**
 * Checks that the engine's numbers agree with each other: the label must match
 * the side of 0.5 that p_positive falls on, and confidence must be the winning
 * class probability. A mismatch means the output cannot be trusted.
 */
export function isConsistent(raw: RawSentiment): boolean {
  const expectedLabel = raw.pPositive >= 0.5 ? 'POSITIVE' : 'NEGATIVE';
  const expectedConfidence = Math.max(raw.pPositive, 1 - raw.pPositive);
  return raw.label === expectedLabel && Math.abs(raw.confidence - expectedConfidence) < 0.01;
}

/**
 * The supplied model is binary (SST-2). Its output is validated, then mapped
 * to four classes so staff can distinguish "leaning" from "unreadable".
 */
export function classify(
  raw: RawSentiment,
  t: SentimentThresholds,
): { label: SentimentLabel; confidence: number; pPositive: number } {
  let label: SentimentLabel;
  if (!isConsistent(raw) || raw.confidence < t.uncertain) label = 'uncertain';
  else if (raw.confidence < t.neutral) label = 'neutral';
  else label = raw.label === 'POSITIVE' ? 'positive' : 'negative';
  return { label, confidence: raw.confidence, pPositive: raw.pPositive };
}

/** True when the review contains letters the English SST-2 model cannot read. */
export function hasNonLatinLetter(text: string): boolean {
  return /\p{L}/u.test(text) && !/^[\p{Script=Latin}\P{L}]*$/u.test(text);
}

/** True when the star rating and the model strongly disagree; useful for staff triage. */
export function isRatingMismatch(rating: number, label: SentimentLabel | null): boolean {
  return (rating >= 4 && label === 'negative') || (rating <= 2 && label === 'positive');
}

class LatencyWindow {
  private readonly samples: number[] = [];
  constructor(private readonly size: number) {}
  add(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > this.size) this.samples.shift();
  }
  percentile(p: number): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  }
}

interface CachedPrediction {
  update: SentimentUpdate;
  binaryLabel: 'POSITIVE' | 'NEGATIVE';
  expiresAt: number;
}

const PREVIEW_CACHE_TTL_MS = 10 * 60_000;
const PREVIEW_CACHE_MAX = 1000;

export class SentimentService {
  private readonly latency = new LatencyWindow(500);
  private readonly previewCache = new Map<string, CachedPrediction>();

  constructor(
    private readonly analyzer: SentimentAnalyzer | null,
    private readonly thresholds: SentimentThresholds,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /**
   * Real-time debounced preview: queries the C++ engine and caches the
   * predicted label (POSITIVE or NEGATIVE) + confidence so the final Submit
   * click resolves immediately without re-running inference.
   */
  async preview(rawText: string, sessionId?: string | null): Promise<SentimentPreviewResponse> {
    const cleaned = normalizeText(rawText);
    const engineKey = toEngineText(cleaned);
    if (textLength(cleaned) < LIMITS.reviewTextMin || !/[A-Za-z0-9]/.test(engineKey)) {
      return {
        sessionId: sessionId ?? null,
        label: null,
        sentiment: null,
        confidence: null,
        cached: false,
        latencyMs: null,
      };
    }

    const now = this.clock.now();
    const hit = this.previewCache.get(engineKey);
    if (hit && hit.expiresAt > now) {
      return {
        sessionId: sessionId ?? null,
        label: hit.binaryLabel,
        sentiment: hit.update.label,
        confidence: hit.update.confidence,
        cached: true,
        latencyMs: 0,
      };
    }

    const update = await this.evaluateInternal(cleaned, false);
    if (update.status === 'analyzed' && update.label !== null) {
      const binaryLabel: 'POSITIVE' | 'NEGATIVE' = update.label === 'positive' ? 'POSITIVE' : 'NEGATIVE';
      this.storeCache(engineKey, { update, binaryLabel, expiresAt: this.clock.now() + PREVIEW_CACHE_TTL_MS });
      return {
        sessionId: sessionId ?? null,
        label: binaryLabel,
        sentiment: update.label,
        confidence: update.confidence,
        cached: false,
        latencyMs: update.latencyMs,
      };
    }

    return {
      sessionId: sessionId ?? null,
      label: null,
      sentiment: null,
      confidence: null,
      cached: false,
      latencyMs: update.latencyMs,
    };
  }

  /** Never throws: engine problems are recorded on the review, not surfaced to patients. */
  async evaluate(text: string): Promise<SentimentUpdate> {
    return this.evaluateInternal(text, true);
  }

  private async evaluateInternal(text: string, usePreviewCache: boolean): Promise<SentimentUpdate> {
    const base = { analyzedAt: this.clock.now(), model: this.analyzer?.modelId ?? null };
    if (!this.analyzer) {
      return {
        ...base,
        status: 'skipped',
        label: null,
        confidence: null,
        pPositive: null,
        latencyMs: null,
        error: 'DISABLED',
      };
    }

    if (usePreviewCache) {
      const engineKey = toEngineText(normalizeText(text));
      const hit = this.previewCache.get(engineKey);
      if (hit && hit.expiresAt > this.clock.now()) {
        return { ...hit.update, analyzedAt: this.clock.now() };
      }
    }

    const started = performance.now();
    try {
      const raw = await this.analyzer.analyze(text);
      const latencyMs = Math.round((performance.now() - started) * 100) / 100;
      this.latency.add(latencyMs);
      const c = classify(raw, this.thresholds);
      return { ...base, status: 'analyzed', ...c, latencyMs, error: null, analyzedAt: this.clock.now() };
    } catch (err) {
      const code = err instanceof SentimentError ? err.code : 'INTERNAL';
      if (code === 'EMPTY') {
        // Emoji and punctuation have nothing to judge. Text written only in a
        // non-Latin script (Hindi, Gujarati, …) is real feedback the English
        // model cannot read, so it is stored as uncertain for staff — not skipped.
        if (hasNonLatinLetter(text)) {
          return {
            ...base,
            status: 'analyzed',
            label: 'uncertain',
            confidence: null,
            pPositive: null,
            latencyMs: null,
            error: null,
          };
        }
        return {
          ...base,
          status: 'skipped',
          label: null,
          confidence: null,
          pPositive: null,
          latencyMs: null,
          error: code,
        };
      }
      this.logger.warn({ code, err: (err as Error).message }, 'sentiment analysis failed');
      return {
        ...base,
        status: 'failed',
        label: null,
        confidence: null,
        pPositive: null,
        latencyMs: null,
        error: code,
      };
    }
  }

  private storeCache(key: string, entry: CachedPrediction): void {
    if (this.previewCache.size >= PREVIEW_CACHE_MAX) {
      const now = this.clock.now();
      for (const [k, v] of this.previewCache) if (v.expiresAt <= now) this.previewCache.delete(k);
      if (this.previewCache.size >= PREVIEW_CACHE_MAX) {
        const oldest = this.previewCache.keys().next().value;
        if (oldest !== undefined) this.previewCache.delete(oldest);
      }
    }
    this.previewCache.set(key, entry);
  }

  status() {
    const s = this.analyzer?.status();
    return {
      ready: s?.ready ?? false,
      workers: s?.workers ?? 0,
      p50Ms: this.latency.percentile(50),
      p95Ms: this.latency.percentile(95),
    };
  }
}
