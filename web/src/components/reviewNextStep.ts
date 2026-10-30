import { RATING_LABELS, type SubmitReviewResponse } from '@stellar/shared';
import { copyText } from '../lib/clipboard';
import { byId, h, replaceChildren } from '../lib/dom';

/** Everything the post-submission screens need; persisted so the patient can come back to it. */
export interface ReviewSubmission {
  rating: number;
  /** Exactly as typed — this is what the patient pastes on Google. */
  text: string;
  result: SubmitReviewResponse;
  submittedAt: number;
}

export interface NextStepHandlers {
  /** Called before the standalone complaint page opens so it can be prefilled. */
  onComplaint(submission: ReviewSubmission): void;
  /** Opens or navigates to Google; injectable for tests. */
  navigate(url: string): void;
}

export function renderStars(rating: number): HTMLElement {
  return h(
    'span',
    { title: `${rating} of 5 – ${RATING_LABELS[rating]}` },
    h(
      'span',
      { 'aria-hidden': 'true' },
      '★'.repeat(rating),
      h('span', { class: 'rating__empty' }, '★'.repeat(5 - rating)),
    ),
    h('span', { class: 'sr-only' }, `${rating} of 5 stars`),
  );
}

export function selectReviewText(): void {
  const el = byId('your-text');
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.addRange(range);
}

/**
 * Renders the post-submission state into `#success-view` and `#escalation-view`.
 */
export function renderNextStep(submission: ReviewSubmission, handlers: NextStepHandlers): void {
  const { rating, text, result } = submission;
  const googleUrl = result.googleUrl ?? result.googleReviewUrl;
  const toComplaint = result.status ? result.status === 'NEGATIVE' : result.next === 'complaint';

  replaceChildren(byId('your-rating'), renderStars(rating));
  byId('your-text').textContent = text;
  byId('google-stars-hint').textContent = `${rating} ${rating === 1 ? 'star' : 'stars'}`;

  // Populate the locked read-only preview accordion in the escalation view.
  const escalationRating = document.getElementById('escalation-rating');
  if (escalationRating) replaceChildren(escalationRating, renderStars(rating));
  const escalationText = document.getElementById('escalation-review-text') as HTMLTextAreaElement | null;
  if (escalationText) escalationText.value = text;

  const google = byId<HTMLAnchorElement>('google-link');
  google.href = googleUrl;
  const proceedBtn = document.getElementById('proceed-google-btn') as HTMLAnchorElement | null;
  if (proceedBtn) proceedBtn.href = googleUrl;
  const escalationGoogle = document.getElementById('escalation-google-link') as HTMLAnchorElement | null;
  if (escalationGoogle) escalationGoogle.href = googleUrl;

  const copyStatus = byId('copy-status');
  const reviewStatus = byId('copy-review-status');
  const label = byId('google-label');

  byId('next-complaint').hidden = !toComplaint;
  byId('contact-hint').hidden = toComplaint;
  byId('decline-google').hidden = toComplaint;
  byId('next-google').classList.toggle('next-step--secondary', toComplaint);
  byId('google-title').textContent = toComplaint ? 'Prefer to share it publicly?' : 'Share your review on Google';

  const complaintLink = document.getElementById('complaint-link') as HTMLAnchorElement | null;
  if (complaintLink) {
    complaintLink.onclick = () => handlers.onComplaint(submission);
  }

  byId<HTMLButtonElement>('copy-review').onclick = async () => {
    const ok = await copyText(text);
    reviewStatus.textContent = ok ? 'Copied to your clipboard.' : 'Could not copy — the text above is now selected.';
    if (!ok) selectReviewText();
  };

  let copied = false;
  google.onclick = async (event) => {
    event.preventDefault();
    if (!copied) copied = await copyText(text);
    if (copied) {
      copyStatus.textContent =
        'Review copied to clipboard! Opening Google Reviews—simply press Paste (Ctrl+V / Cmd+V) to post.';
      copyStatus.classList.add('copy-status--ok');
      handlers.navigate(googleUrl);
    } else if (label.dataset.fallback !== '1') {
      label.dataset.fallback = '1';
      label.textContent = 'Proceed to Google Reviews';
      copyStatus.textContent =
        "We couldn't access your clipboard. Copy your review from the box above (it's selected), then open Google.";
      copyStatus.classList.remove('copy-status--ok');
      selectReviewText();
    } else {
      handlers.navigate(googleUrl);
    }
  };

  byId<HTMLButtonElement>('decline-google').onclick = () => {
    byId('next-google').hidden = true;
    byId('declined-note').hidden = false;
  };
}
