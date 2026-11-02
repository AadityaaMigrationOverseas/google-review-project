import type { SentimentLabel } from './constants.js';

export type ReviewNextStep = 'google' | 'complaint';
export type ReviewRoutingStatus = 'POSITIVE' | 'NEGATIVE';

/**
 * Patient-facing next step.
 *
 * Google's review policy forbids "review gating" — selectively steering only happy
 * patients to Google. So EVERY patient is shown the Google review option with equal
 * prominence, and the private complaint form is always offered as an additional
 * choice. The patient's rating and the sentiment verdict never change what is shown;
 * they feed internal reporting and staff flags only (see `classifyReviewStatus`).
 */
export function nextStepFor(): ReviewNextStep {
  return 'google';
}

/**
 * INTERNAL-ONLY classification for staff dashboards, analytics and audit logs.
 * It is never used to route or gate the patient experience.
 * - rating <= 3 OR sentiment != 'positive' -> NEGATIVE
 * - rating >= 4 AND sentiment == 'positive' -> POSITIVE
 * - When the C++ engine is unavailable / timed out (sentiment === null), fall back
 *   to the star-rating heuristic (rating >= 4 -> POSITIVE, rating <= 3 -> NEGATIVE).
 */
export function classifyReviewStatus(rating: number, sentiment: SentimentLabel | null): ReviewRoutingStatus {
  if (sentiment === null) return rating >= 4 ? 'POSITIVE' : 'NEGATIVE';
  return sentiment === 'positive' && rating >= 4 ? 'POSITIVE' : 'NEGATIVE';
}
