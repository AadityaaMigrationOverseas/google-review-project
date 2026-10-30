/** Hands the review over to the complaint form within the tab only (sessionStorage, never the URL). */
export const COMPLAINT_PREFILL_KEY = 'sdc:complaint-prefill';

export function takeComplaintPrefill(): { rating: number; details: string } | null {
  const raw = sessionStorage.getItem(COMPLAINT_PREFILL_KEY);
  sessionStorage.removeItem(COMPLAINT_PREFILL_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { rating?: unknown; details?: unknown };
    if (typeof v.rating !== 'number' || typeof v.details !== 'string') return null;
    return { rating: v.rating, details: v.details };
  } catch {
    return null;
  }
}
