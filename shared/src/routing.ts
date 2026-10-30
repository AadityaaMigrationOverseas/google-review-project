import type { SentimentLabel } from './constants.js';

export type ReviewNextStep = 'google' | 'complaint';
export type ReviewRoutingStatus = 'POSITIVE' | 'NEGATIVE';

/**
 * Authoritative routing rule:
 * - If rating <= 3 OR sentiment != 'positive' -> NEGATIVE ('complaint')
 * - If rating >= 4 AND sentiment == 'positive' -> POSITIVE ('google')
 * - When C++ engine is unavailable / timed out (sentiment === null), fallback
 *   to star rating heuristic (rating >= 4 -> POSITIVE, rating <= 3 -> NEGATIVE).
 */
export function nextStepFor(rating: number, sentiment: SentimentLabel | null): ReviewNextStep {
  if (sentiment === null) return rating >= 4 ? 'google' : 'complaint';
  return sentiment === 'positive' && rating >= 4 ? 'google' : 'complaint';
}

export function classifyReviewStatus(rating: number, sentiment: SentimentLabel | null): ReviewRoutingStatus {
  return nextStepFor(rating, sentiment) === 'google' ? 'POSITIVE' : 'NEGATIVE';
}
