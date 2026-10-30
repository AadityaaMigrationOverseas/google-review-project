/**
 * Content script injected into Google Search / Google Maps review modal frames
 * (`all_frames: true` on `*://*.google.com/*`).
 *
 * Automatically:
 * 1. Clicks "Write a review" if the modal isn't already open.
 * 2. Selects the star rating (e.g. 5 stars) inside the Google review dialog.
 * 3. Pastes/populates the exact review text into the
 *    "Share details of your own experience at this place" text box.
 * 4. HARD GUARDRAIL: NEVER clicks the "Post" / "Publish" / "Submit" button.
 */
(() => {
  const STORAGE_KEY = 'sdc_pending_google_review';
  const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
  const FORBIDDEN_SUBMIT = /\b(post|publish|submit|send)\b/i;

  const STAR_WORDS = {
    1: ['One star', '1 star'],
    2: ['Two stars', '2 stars'],
    3: ['Three stars', '3 stars'],
    4: ['Four stars', '4 stars'],
    5: ['Five stars', '5 stars'],
  };

  function isForbiddenButton(el) {
    if (!el) return true;
    const text =
      `${el.textContent || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-value') || ''}`.trim();
    return FORBIDDEN_SUBMIT.test(text);
  }

  function findReviewTextarea() {
    const selectors = [
      'textarea[placeholder*="Share details of your own experience" i]',
      'textarea[aria-label*="Share details of your own experience" i]',
      'textarea[placeholder*="Share details" i]',
      'textarea[aria-label*="Share details" i]',
      'textarea[placeholder*="experience" i]',
      'textarea[aria-label*="experience" i]',
      'textarea[aria-label*="review" i]',
      'textarea[placeholder*="review" i]',
      'div[role="textbox"][aria-label*="Share details" i]',
      'div[role="textbox"][aria-label*="experience" i]',
      'div[role="textbox"][aria-label*="review" i]',
      'div[contenteditable="true"][aria-label*="Share details" i]',
      'div[contenteditable="true"][aria-label*="review" i]',
      'textarea',
    ];

    for (const sel of selectors) {
      const candidates = document.querySelectorAll(sel);
      for (const el of candidates) {
        if (isForbiddenButton(el)) continue;
        if (el.closest('[hidden]') || el.disabled || el.readOnly) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 40 && rect.height > 20) {
          return el;
        }
      }
    }
    return null;
  }

  function selectGoogleStarRating(rating) {
    const r = Math.min(5, Math.max(1, Number(rating) || 5));
    const labels = STAR_WORDS[r] || STAR_WORDS[5];

    const selectors = [
      ...labels.map((l) => `[aria-label="${l}" i]`),
      ...labels.map((l) => `[aria-label*="${l}" i]`),
      `[data-rating="${r}"]`,
      `[role="radio"][aria-posinset="${r}"]`,
      `[role="radiogroup"] [role="radio"]:nth-of-type(${r})`,
    ];

    for (const sel of selectors) {
      const star = document.querySelector(sel);
      if (star && !isForbiddenButton(star)) {
        star.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        star.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        star.click();
        return true;
      }
    }
    return false;
  }

  function fillReviewText(field, text) {
    if (!field || isForbiddenButton(field)) return false;

    field.focus();

    if (field.tagName && field.tagName.toLowerCase() === 'textarea') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(field, text);
      } else {
        field.value = text;
      }
      field.dispatchEvent(
        new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }),
      );
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
      return field.value === text;
    }

    // Contenteditable / role="textbox" fallback
    field.textContent = text;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return field.textContent === text;
  }

  let writeClicked = false;
  function tryClickWriteReviewIfOnSearchPage() {
    if (writeClicked) return;
    // Only click "Write a review" if we are on the search page and no textarea is visible yet.
    const candidates = document.querySelectorAll(
      '[data-attribution="lu-desktop-write-review"], [aria-label*="Write a review" i], a[role="button"], div[role="button"], button',
    );
    for (const el of candidates) {
      const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.trim();
      if (/^write a review/i.test(label) && !isForbiddenButton(el)) {
        writeClicked = true;
        el.click();
        return;
      }
    }
  }

  function attemptAutofill() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      const item = res && res[STORAGE_KEY];
      if (!item || !item.reviewText) return;
      if (Date.now() - Number(item.timestamp || 0) > MAX_AGE_MS) return;

      const field = findReviewTextarea();
      if (!field) {
        // If we are on a Google Search local listing page with #lrd=, try opening the Write a review modal.
        if (location.href.includes('lrd=') || location.href.includes('writereview')) {
          tryClickWriteReviewIfOnSearchPage();
        }
        return;
      }

      // If the user hasn't typed anything yet or it doesn't match, populate it once.
      const currentVal = (field.value ?? field.textContent ?? '').trim();
      if (currentVal === item.reviewText.trim()) return;
      if (item.consumed && currentVal.length > 0) return;

      selectGoogleStarRating(item.rating);
      const ok = fillReviewText(field, item.reviewText);
      if (ok) {
        chrome.storage.local.set({
          [STORAGE_KEY]: { ...item, consumed: true },
        });
      }
    });
  }

  // Poll briefly and observe DOM mutations as Google's review modal iframe loads asynchronously.
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    attemptAutofill();
    if (attempts > 60) clearInterval(interval); // Stop polling after 30 seconds
  }, 500);

  const observer = new MutationObserver(() => {
    attemptAutofill();
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  attemptAutofill();
})();
