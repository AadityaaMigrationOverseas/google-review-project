import '../styles/main.css';
import {
  LIMITS,
  normalizeText,
  textLength,
  validateEmail,
  validateFullName,
  validatePhone,
  validateRating,
  validateReviewText,
  type SentimentPreviewResponse,
  type SubmitComplaintRequest,
  type SubmitComplaintResponse,
  type SubmitReviewRequest,
  type SubmitReviewResponse,
} from '@stellar/shared';
import { bindCounter, FormController, newIdempotencyKey, setBusy, showAlert } from '../components/form';
import { renderNextStep, selectReviewText, type ReviewSubmission } from '../components/reviewNextStep';
import { mountStarRating } from '../components/starRating';
import { api, ApiRequestError } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { COMPLAINT_PREFILL_KEY } from '../lib/complaintPrefill';
import { byId, debounce } from '../lib/dom';
import { fetchFormToken, isTokenError, type FormTokenInfo } from '../lib/formToken';
import { executeGoogleReviewHandoff } from '../lib/googleReviewHandoff';
import { clearSubmission, loadSubmission, saveSubmission } from '../lib/reviewSession';

const SESSION_ID_KEY = 'sdc:session-id';

function getOrCreateSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_ID_KEY);
    if (existing && /^[A-Za-z0-9-]{16,64}$/.test(existing)) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(SESSION_ID_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

const sessionId = getOrCreateSessionId();
const form = byId<HTMLFormElement>('review-form');
form.dataset.sessionId = sessionId;

const textarea = byId<HTMLTextAreaElement>('review-text');
const consent = byId<HTMLInputElement>('consent');
const submitBtn = byId<HTMLButtonElement>('submit-btn');
const formAlert = byId('form-alert');
const previewBadge = byId('sentiment-preview-badge');
const copyToast = byId('copy-toast');
const clipboardModal = byId('clipboard-modal');
const clipboardModalBtn = byId<HTMLButtonElement>('clipboard-modal-btn');
const popupBlockedNotice = byId('popup-blocked-notice');
const starsRoot = form.querySelector<HTMLElement>('[data-stars]')!;

const escalationForm = byId<HTMLFormElement>('escalation-form');
const fullNameInput = byId<HTMLInputElement>('full-name');
const escalationPhoneInput = byId<HTMLInputElement>('escalation-phone');
const escalationEmailInput = byId<HTMLInputElement>('escalation-email');
const escalationSubmitBtn = byId<HTMLButtonElement>('escalation-submit-btn');
const escalationAlert = byId('escalation-alert');

const linkCode = /^\/r\/([A-Za-z0-9]{6,16})\/?$/.exec(location.pathname)?.[1] ?? null;

let previewSeq = 0;
let activeSubmission: ReviewSubmission | null = null;
let toastTimer: number | null = null;

/**
 * Step 1: Disable "Submit Review" button until at least 1 star is selected
 * and the review text reaches the minimum character threshold (5 chars).
 */
function updateSubmitButtonState(): void {
  const hasStar = stars.value !== null && stars.value >= 1;
  const cleaned = normalizeText(textarea.value);
  const len = textLength(cleaned);
  const hasText = len >= LIMITS.reviewTextMin && len <= LIMITS.reviewTextMax;
  submitBtn.disabled = !(hasStar && hasText);
}

const stars = mountStarRating(starsRoot, () => {
  controller.check('rating');
  updateSubmitButtonState();
});
bindCounter(textarea, byId('text-count'), LIMITS.reviewTextMax);

const controller = new FormController(form, {
  rating: {
    control: starsRoot,
    sources: [...starsRoot.querySelectorAll<HTMLInputElement>('input')],
    validate: () => validateRating(stars.value),
    focus: () => stars.focus(),
  },
  text: { control: textarea, validate: () => validateReviewText(normalizeText(textarea.value)) },
  consent: {
    control: consent,
    validate: () => (consent.checked ? null : 'Please confirm you agree to us storing your feedback.'),
  },
});

const escalationController = new FormController(escalationForm, {
  fullName: {
    control: fullNameInput,
    validate: () => validateFullName(normalizeText(fullNameInput.value)),
  },
  phone: {
    control: escalationPhoneInput,
    validate: () => validatePhone(escalationPhoneInput.value),
  },
  email: {
    control: escalationEmailInput,
    validate: () => validateEmail(escalationEmailInput.value.trim().toLowerCase()),
  },
});

/**
 * Step 2: Real-time debounced sentiment check (POST /api/sentiment/preview, 350ms).
 * Warms the backend C++ sentiment cache so final submission is instantaneous.
 */
const runSentimentPreview = debounce(async () => {
  const raw = textarea.value;
  const cleaned = normalizeText(raw);
  if (textLength(cleaned) < LIMITS.reviewTextMin) {
    previewBadge.hidden = true;
    return;
  }
  const seq = ++previewSeq;
  try {
    const res = await api<SentimentPreviewResponse>('/api/sentiment/preview', {
      method: 'POST',
      body: { sessionId, reviewText: raw },
    });
    if (seq !== previewSeq) return;
    if (res.label) {
      previewBadge.dataset.sentiment = res.label;
      previewBadge.textContent = res.label === 'POSITIVE' ? 'Verified · Positive tone' : 'Verified · Direct care route';
      previewBadge.hidden = false;
    } else {
      previewBadge.hidden = true;
    }
  } catch {
    /* Preview is best-effort; authoritative check runs on submit. */
  }
}, 350);

textarea.addEventListener('input', () => {
  updateSubmitButtonState();
  runSentimentPreview();
});

updateSubmitButtonState();

let idempotencyKey = newIdempotencyKey();
let escalationIdempotencyKey = newIdempotencyKey();
let token: Promise<FormTokenInfo> = loadToken();

function loadToken(): Promise<FormTokenInfo> {
  const p = fetchFormToken('review', linkCode);
  p.then((info) => {
    if (info.linkValid === false) byId('link-alert').hidden = false;
    byId<HTMLAnchorElement>('google-link').href = info.googleReviewUrl;
    byId<HTMLAnchorElement>('proceed-google-btn').href = info.googleReviewUrl;
    byId<HTMLAnchorElement>('escalation-google-link').href = info.googleReviewUrl;
  }).catch(() => {
    /* surfaced on submit if needed */
  });
  return p;
}

function showToast(message?: string): void {
  if (message) byId('copy-toast-text').textContent = message;
  copyToast.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    copyToast.hidden = true;
  }, 6000);
}

async function launchGoogleReviewFlow(
  url: string,
  reviewText: string,
  alreadyCopied: boolean,
  preOpenedPopup?: Window | null,
): Promise<void> {
  const handoff = await executeGoogleReviewHandoff({
    url,
    reviewText,
    alreadyCopied,
    ...(preOpenedPopup ? { openWindow: () => preOpenedPopup } : {}),
  });

  const copyStatus = byId('copy-status');
  if (handoff.mode === 'clipboard_blocked_manual_copy') {
    clipboardModal.hidden = false;
    copyStatus.textContent =
      "We couldn't access your clipboard automatically. Use the button to copy your review and open Google.";
    copyStatus.classList.remove('copy-status--ok');
    selectReviewText();
    clipboardModalBtn.focus();
    return;
  }

  clipboardModal.hidden = true;
  const toastMessage =
    'Review copied to clipboard! Opening Google "Write a Review" dialog—press Paste (Ctrl+V / Cmd+V) and click Post.';
  showToast(toastMessage);
  copyStatus.textContent = toastMessage;
  copyStatus.classList.add('copy-status--ok');
  popupBlockedNotice.hidden = handoff.tabOpened;
}

function showSubmissionView(
  submission: ReviewSubmission,
  opts: { restored?: boolean; copied?: boolean; autoLaunch?: boolean; preOpenedPopup?: Window | null } = {},
): void {
  activeSubmission = submission;
  const { result, text } = submission;
  const googleUrl = result.googleUrl ?? result.googleReviewUrl;

  renderNextStep(submission, {
    onComplaint: (s) =>
      sessionStorage.setItem(COMPLAINT_PREFILL_KEY, JSON.stringify({ rating: s.rating, details: s.text })),
    navigate: (url) => {
      void executeGoogleReviewHandoff({
        url,
        reviewText: text,
        alreadyCopied: true,
      }).then((handoff) => {
        popupBlockedNotice.hidden = handoff.tabOpened;
        if (!handoff.tabOpened) location.assign(url);
      });
    },
  });

  byId('review-view').hidden = true;

  // Every patient — regardless of rating or sentiment — sees the Google review option
  // with equal prominence. The private complaint form is offered as an extra choice
  // (the "Tell the clinic privately" button reveals the in-page escalation form).
  byId('escalation-view').hidden = true;
  byId('escalation-confirmation-view').hidden = true;
  const success = byId('success-view');
  success.hidden = false;

  if (!opts.restored && opts.autoLaunch) {
    void launchGoogleReviewFlow(googleUrl, text, Boolean(opts.copied), opts.preOpenedPopup);
  }

  if (!opts.restored && clipboardModal.hidden) {
    success.focus();
    success.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  document.title = 'Thank you · Stellar Dental Clinic';
}

/** The private complaint form is an optional extra choice: reveal it in-place on request. */
byId('open-complaint').addEventListener('click', () => {
  if (!activeSubmission) return;
  sessionStorage.setItem(
    COMPLAINT_PREFILL_KEY,
    JSON.stringify({ rating: activeSubmission.rating, details: activeSubmission.text }),
  );
  byId('success-view').hidden = true;
  const escalation = byId('escalation-view');
  escalation.hidden = false;
  fullNameInput.focus();
  escalation.scrollIntoView({ block: 'start', behavior: 'smooth' });
  document.title = 'Share privately with the clinic · Stellar Dental Clinic';
});

clipboardModalBtn.addEventListener('click', async () => {
  if (!activeSubmission) return;
  const text = activeSubmission.text;
  const googleUrl = activeSubmission.result.googleUrl ?? activeSubmission.result.googleReviewUrl;
  const ok = await copyText(text);
  clipboardModal.hidden = true;
  if (ok) {
    showToast('Review copied to clipboard! Opening Google Reviews—simply press Paste (Ctrl+V / Cmd+V) to post.');
    const copyStatus = byId('copy-status');
    copyStatus.textContent =
      'Review copied to clipboard! Opening Google Reviews—simply press Paste (Ctrl+V / Cmd+V) to post.';
    copyStatus.classList.add('copy-status--ok');
  } else {
    selectReviewText();
  }
  const handoff = await executeGoogleReviewHandoff({
    url: googleUrl,
    reviewText: text,
    alreadyCopied: true,
  });
  popupBlockedNotice.hidden = handoff.tabOpened;
});

function resetToReviewForm(): void {
  clearSubmission();
  activeSubmission = null;
  form.reset();
  consent.checked = true;
  escalationForm.reset();
  stars.reset();
  updateSubmitButtonState();
  idempotencyKey = newIdempotencyKey();
  escalationIdempotencyKey = newIdempotencyKey();
  token = loadToken();
  previewBadge.hidden = true;
  copyToast.hidden = true;
  clipboardModal.hidden = true;
  popupBlockedNotice.hidden = true;
  byId('success-view').hidden = true;
  byId('escalation-view').hidden = true;
  byId('escalation-confirmation-view').hidden = true;
  byId('declined-note').hidden = true;
  byId('next-google').hidden = false;
  byId('review-view').hidden = false;
  document.title = 'Share your experience · Stellar Dental Clinic';
  stars.focus();
}

byId('new-review').addEventListener('click', resetToReviewForm);
byId('escalation-new-review').addEventListener('click', resetToReviewForm);

// Returning from Google (back button) or a reload: keep the patient's words on screen.
const previous = loadSubmission();
if (previous) showSubmissionView(previous, { restored: true });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showAlert(formAlert, 'error', null);
  if (!controller.validateAll()) return;

  const rawText = textarea.value;
  const ratingValue = stars.value!;

  // The Google review option is offered to every patient with equal prominence (no
  // sentiment-based gating), so copy the review text and open the Google "Write a
  // Review" dialog within the user-gesture context for all submissions — without
  // waiting for the backend round-trip.
  const gestureCopyPromise: Promise<boolean> = copyText(rawText);
  let preOpenedPopup: Window | null = null as Window | null;
  void gestureCopyPromise.then((copiedOk) => {
    if (copiedOk) {
      const initialGoogleUrl = byId<HTMLAnchorElement>('google-link').href;
      try {
        preOpenedPopup = window.open(initialGoogleUrl, '_blank');
      } catch {
        preOpenedPopup = null;
      }
    }
  });

  setBusy(submitBtn, true, 'Submitting…');
  try {
    let formTokenValue: string | undefined;
    try {
      const info = await token;
      formTokenValue = info.formToken;
    } catch {
      /* /api/reviews/submit does not block on formToken if token fetch failed */
    }

    const payload: SubmitReviewRequest = {
      sessionId,
      rating: ratingValue,
      reviewText: rawText,
      text: rawText,
      consent: consent.checked,
      linkCode,
      idempotencyKey,
      formToken: formTokenValue,
      website: byId<HTMLInputElement>('website').value,
    };

    const result = await api<SubmitReviewResponse>('/api/reviews/submit', { method: 'POST', body: payload });
    const copied = await gestureCopyPromise;

    const submission: ReviewSubmission = {
      rating: ratingValue,
      text: rawText,
      result,
      submittedAt: Date.now(),
    };
    saveSubmission(submission);
    showSubmissionView(submission, { copied, autoLaunch: true, preOpenedPopup });
  } catch (err) {
    if (preOpenedPopup) {
      try {
        preOpenedPopup.close();
      } catch {
        /* ignore */
      }
    }
    if (isTokenError(err)) {
      token = loadToken();
      showAlert(formAlert, 'warning', `${err.message.split('.')[0]}. We've refreshed it — please press Submit again.`);
    } else if (err instanceof ApiRequestError) {
      if (err.code === 'validation_failed') controller.applyServerErrors(err.fields);
      showAlert(formAlert, err.status === 425 ? 'info' : 'error', err.message);
    } else {
      showAlert(formAlert, 'error', 'Something went wrong. Please try again.');
    }
  } finally {
    setBusy(submitBtn, false);
    updateSubmitButtonState();
  }
});

/**
 * Step 5: Internal Escalation Form submission (POST /api/complaints/submit)
 * without page reload.
 */
escalationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showAlert(escalationAlert, 'error', null);
  if (!escalationController.validateAll()) return;

  const rating = activeSubmission?.rating ?? stars.value ?? 1;
  const reviewText = activeSubmission?.text ?? textarea.value;
  const reviewId =
    activeSubmission?.result.reviewId ?? (activeSubmission ? String(activeSubmission.result.id) : undefined);

  setBusy(escalationSubmitBtn, true, 'Sending…');
  try {
    const payload: SubmitComplaintRequest = {
      sessionId,
      reviewId,
      fullName: fullNameInput.value,
      phone: escalationPhoneInput.value,
      email: escalationEmailInput.value,
      rating,
      reviewText,
      details: reviewText,
      consent: true,
      idempotencyKey: escalationIdempotencyKey,
      website: byId<HTMLInputElement>('escalation-website').value,
    };

    const res = await api<SubmitComplaintResponse>('/api/complaints/submit', {
      method: 'POST',
      body: payload,
    });

    clearSubmission();
    byId('escalation-reference').textContent = res.reference;
    if (res.message) {
      byId('escalation-confirmed-message').textContent = res.message;
    }
    byId('escalation-view').hidden = true;
    const confirmedView = byId('escalation-confirmation-view');
    confirmedView.hidden = false;
    confirmedView.focus();
    confirmedView.scrollIntoView({ block: 'start', behavior: 'smooth' });
    document.title = 'Message received · Stellar Dental Clinic';
  } catch (err) {
    if (err instanceof ApiRequestError) {
      if (err.code === 'validation_failed') escalationController.applyServerErrors(err.fields);
      showAlert(escalationAlert, err.status === 425 ? 'info' : 'error', err.message);
    } else {
      showAlert(escalationAlert, 'error', 'Something went wrong. Please try again.');
    }
  } finally {
    setBusy(escalationSubmitBtn, false);
  }
});
