/**
 * Content script injected into the Stellar Dental Clinic Review Portal
 * (http://localhost:3000/review).
 *
 * Captures the patient's positive review text and star rating the moment they
 * click "Submit Review" and stores it in `chrome.storage.local` so the Google
 * review modal content script (`google-autofill.js`) can automatically fill
 * the "Share details of your own experience at this place" text box and stars.
 */
(() => {
  const STORAGE_KEY = 'sdc_pending_google_review';

  function savePendingReview(reviewText, rating) {
    if (!reviewText || typeof reviewText !== 'string' || !reviewText.trim()) return;
    const numericRating = Number(rating) || 5;
    if (numericRating < 4) return;
    try {
      chrome.storage.local.set({
        [STORAGE_KEY]: {
          reviewText: reviewText.trim(),
          rating: numericRating,
          timestamp: Date.now(),
          consumed: false,
        },
      });
    } catch {
      /* ignore context invalidated */
    }
  }

  // 1. Listen for window.postMessage across isolated worlds from the portal's JS bundle.
  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (data && data.type === 'SDC_REVIEW_HANDOFF' && data.reviewText) {
      savePendingReview(data.reviewText, data.rating);
    }
  });

  // 2. Capture synchronously when the user clicks #submit-btn or submits #review-form.
  function captureFromForm() {
    const textarea = document.getElementById('review-text');
    const checkedStar = document.querySelector('input[name="rating"]:checked');
    const rating = checkedStar ? Number(checkedStar.value) : 5;
    if (textarea && textarea.value && rating >= 4) {
      savePendingReview(textarea.value, rating);
    }
  }

  document.addEventListener(
    'click',
    (event) => {
      const target =
        event.target &&
        event.target.closest &&
        event.target.closest('#submit-btn, #google-link, #proceed-google-btn, #clipboard-modal-btn');
      if (target) {
        captureFromForm();
        syncFromSessionStorage();
      }
    },
    true,
  );

  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (form && form.id === 'review-form') {
        captureFromForm();
      }
    },
    true,
  );

  // 3. Also sync from sessionStorage or root dataset attributes.
  function syncFromSessionStorage() {
    try {
      if (document.documentElement.dataset.sdcReviewText) {
        savePendingReview(
          document.documentElement.dataset.sdcReviewText,
          document.documentElement.dataset.sdcReviewRating || 5,
        );
      }
      const raw = sessionStorage.getItem('sdc:last-submission:v1');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.text && Number(parsed.rating) >= 4) {
        savePendingReview(parsed.text, parsed.rating);
      }
    } catch {
      /* ignore */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncFromSessionStorage);
  } else {
    syncFromSessionStorage();
  }
})();
