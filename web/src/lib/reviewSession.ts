import type { ReviewSubmission } from '../components/reviewNextStep';

/**
 * Keeps the submitted review in this tab (sessionStorage, never the URL) so the
 * patient still has their words after coming back from Google.
 */
const KEY = 'sdc:review-submission';
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function saveSubmission(s: ReviewSubmission): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or disabled: the screen still works for this page view */
  }
}

export function loadSubmission(now = Date.now()): ReviewSubmission | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<ReviewSubmission>;
    if (
      typeof s.rating !== 'number' ||
      typeof s.text !== 'string' ||
      typeof s.submittedAt !== 'number' ||
      !s.result ||
      typeof s.result.googleReviewUrl !== 'string' ||
      now - s.submittedAt > MAX_AGE_MS
    ) {
      clearSubmission();
      return null;
    }
    return s as ReviewSubmission;
  } catch {
    return null;
  }
}

export function clearSubmission(): void {
  sessionStorage.removeItem(KEY);
}
