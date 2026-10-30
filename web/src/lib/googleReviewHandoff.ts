import { copyText } from './clipboard';

/**
 * Semi-automated Google Reviews handoff & DOM prefill module.
 *
 * SAFETY & POLICY CONTRACT:
 * 1. Opens the target Google Maps / Business Profile URL.
 * 2. When DOM access is available (e.g., same-origin test stub or accessible browsing context),
 *    waits for loading states, locates and clicks the "Write a review" button (if not already
 *    in the direct `writereview` composer), selects the star rating, and populates the exact
 *    review text into the intended review textarea/contenteditable field.
 * 3. HARD GUARDRAIL: Automation STOPS IMMEDIATELY after populating the review field.
 *    It NEVER clicks Post, Publish, or Submit, and never bypasses authentication or CAPTCHAs.
 * 4. CROSS-ORIGIN FALLBACK: When browser Same-Origin Policy blocks cross-origin DOM access to
 *    `google.com` / `share.google`, falls back cleanly to the closest supported alternative:
 *    opening the Google review page and ensuring the exact review text is copied to the user's
 *    clipboard with a prominent "Copy Review" action and manual publish instructions.
 */

export type HandoffMode =
  | 'dom_prefilled_awaiting_user_post'
  | 'clipboard_copied_tab_opened'
  | 'popup_blocked_manual_proceed'
  | 'clipboard_blocked_manual_copy';

export interface GoogleReviewHandoffOptions {
  url: string;
  reviewText: string;
  rating: number;
  alreadyCopied?: boolean;
  /** Optional window opener override (defaults to `window.open`). */
  openWindow?: (url: string) => Window | null;
  /** Maximum time (ms) to wait for accessible target DOM elements to load. */
  domTimeoutMs?: number;
}

export interface GoogleReviewHandoffResult {
  mode: HandoffMode;
  copied: boolean;
  tabOpened: boolean;
  domPrefilled: boolean;
  writeReviewClicked: boolean;
  stoppedBeforeSubmit: true;
  statusMessage: string;
}

const WRITE_REVIEW_SELECTORS = [
  '[data-WriteReview]',
  'button[aria-label*="Write a review" i]',
  'a[aria-label*="Write a review" i]',
  '[role="button"][aria-label*="Write a review" i]',
  'button[data-value*="Write a review" i]',
] as const;

const REVIEW_INPUT_SELECTORS = [
  'textarea[aria-label*="review" i]',
  'textarea[placeholder*="experience" i]',
  'textarea[placeholder*="review" i]',
  'textarea[name*="review" i]',
  'div[role="textbox"][aria-label*="review" i]',
  'div[contenteditable="true"][aria-label*="review" i]',
  'textarea',
] as const;

const FORBIDDEN_SUBMIT_LABELS = /\b(post|publish|submit|send)\b/i;

/**
 * Verifies an element is never a final Post / Publish / Submit control.
 */
export function isForbiddenSubmitControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' && (el as HTMLInputElement).type === 'submit') return true;
  if (tag === 'button' && (el as HTMLButtonElement).type === 'submit') {
    const text = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.trim();
    if (FORBIDDEN_SUBMIT_LABELS.test(text)) return true;
  }
  const label =
    `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-value') ?? ''}`.trim();
  return FORBIDDEN_SUBMIT_LABELS.test(label);
}

function canAccessDocument(win: Window): Document | null {
  try {
    const doc = win.document;
    // Accessing `doc.body` or `win.location.href` throws SecurityError on cross-origin windows.
    void win.location.href;
    return doc ?? null;
  } catch {
    return null;
  }
}

function isAuthOrCaptchaGate(doc: Document): boolean {
  try {
    const url = doc.location?.href ?? '';
    if (/accounts\.google\.com|ServiceLogin|signin/i.test(url)) return true;
    if (doc.querySelector('iframe[src*="recaptcha" i], [id*="captcha" i], input[type="password"]')) return true;
    return false;
  } catch {
    return true;
  }
}

function findWriteReviewButton(doc: Document): HTMLElement | null {
  for (const selector of WRITE_REVIEW_SELECTORS) {
    const found = doc.querySelector<HTMLElement>(selector);
    if (found && !isForbiddenSubmitControl(found)) return found;
  }
  const candidates = doc.querySelectorAll<HTMLElement>('button, a, [role="button"]');
  for (const el of candidates) {
    const text = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.trim();
    if (/write\s+a\s+review/i.test(text) && !isForbiddenSubmitControl(el)) {
      return el;
    }
  }
  return null;
}

function findReviewField(doc: Document): HTMLTextAreaElement | HTMLElement | null {
  for (const selector of REVIEW_INPUT_SELECTORS) {
    const el = doc.querySelector<HTMLElement>(selector);
    if (!el || el.closest('[hidden]') || isForbiddenSubmitControl(el)) continue;
    if (el instanceof doc.defaultView!.HTMLTextAreaElement) {
      if (!el.readOnly && !el.disabled) return el;
    } else if (
      el.isContentEditable ||
      el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('role') === 'textbox'
    ) {
      return el;
    }
  }
  return null;
}

function trySelectRatingStar(doc: Document, rating: number): void {
  if (rating < 1 || rating > 5) return;
  const starSelectors = [
    `[aria-label="${rating} star" i]`,
    `[aria-label="${rating} stars" i]`,
    `[data-rating="${rating}"]`,
    `[role="radio"][aria-posinset="${rating}"]`,
  ];
  for (const sel of starSelectors) {
    const star = doc.querySelector<HTMLElement>(sel);
    if (star && !isForbiddenSubmitControl(star)) {
      star.click();
      return;
    }
  }
}

function populateReviewField(doc: Document, field: HTMLTextAreaElement | HTMLElement, text: string): boolean {
  if (isForbiddenSubmitControl(field)) return false;
  const win = doc.defaultView;
  if (!win) return false;

  if (field.tagName.toLowerCase() === 'textarea') {
    const ta = field as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(ta, text);
    else ta.value = text;
    ta.dispatchEvent(new win.Event('input', { bubbles: true }));
    ta.dispatchEvent(new win.Event('change', { bubbles: true }));
    ta.focus();
    return ta.value === text;
  }

  field.textContent = text;
  field.dispatchEvent(new win.Event('input', { bubbles: true }));
  field.dispatchEvent(new win.Event('change', { bubbles: true }));
  field.focus();
  return field.textContent === text;
}

/**
 * Attempts to detect "Write a review", click it, and populate the review field
 * within an accessible target Document. Stops immediately after populating the field.
 */
export async function tryAutomateAccessibleReviewModal(
  win: Window,
  opts: { reviewText: string; rating: number; timeoutMs?: number },
): Promise<{ prefilled: boolean; writeReviewClicked: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 1200;
  const deadline = Date.now() + timeoutMs;
  let writeReviewClicked = false;

  while (Date.now() <= deadline) {
    const doc = canAccessDocument(win);
    if (!doc) {
      // Cross-origin navigation occurred; browser Same-Origin Policy forbids DOM access.
      return { prefilled: false, writeReviewClicked };
    }

    // Never bypass authentication or CAPTCHA gates.
    if (isAuthOrCaptchaGate(doc)) {
      return { prefilled: false, writeReviewClicked };
    }

    // Step A: If the review field is already present, select stars, populate text, and STOP.
    const field = findReviewField(doc);
    if (field) {
      trySelectRatingStar(doc, opts.rating);
      const ok = populateReviewField(doc, field, opts.reviewText);
      // HARD STOP: Never click Post / Publish / Submit.
      return { prefilled: ok, writeReviewClicked };
    }

    // Step B: If a "Write a review" button is visible, click it once to open the modal.
    if (!writeReviewClicked) {
      const writeBtn = findWriteReviewButton(doc);
      if (writeBtn) {
        writeBtn.click();
        writeReviewClicked = true;
        // Check immediately if clicking synchronously revealed the review input.
        const revealedField = findReviewField(doc);
        if (revealedField) {
          trySelectRatingStar(doc, opts.rating);
          const ok = populateReviewField(doc, revealedField, opts.reviewText);
          return { prefilled: ok, writeReviewClicked: true };
        }
      }
    }

    await new Promise((r) => setTimeout(r, 40));
  }

  return { prefilled: false, writeReviewClicked };
}

/**
 * Executes the semi-automated Google Reviews workflow:
 * 1. Copies the exact review text to the clipboard (unless already copied in the click gesture).
 * 2. Opens the Google review destination URL (preferring the direct `writereview` modal URL when configured).
 * 3. Attempts safe DOM prefill of "Write a review" + review text field if the target context is accessible,
 *    stopping immediately before the Post/Publish button.
 * 4. Gracefully falls back to clipboard + manual paste instructions when cross-origin restrictions apply.
 */
export async function executeGoogleReviewHandoff(opts: GoogleReviewHandoffOptions): Promise<GoogleReviewHandoffResult> {
  try {
    document.documentElement.dataset.sdcReviewText = opts.reviewText;
    document.documentElement.dataset.sdcReviewRating = String(opts.rating);
    window.postMessage(
      {
        type: 'SDC_REVIEW_HANDOFF',
        url: opts.url,
        reviewText: opts.reviewText,
        rating: opts.rating,
        timestamp: Date.now(),
      },
      '*',
    );
    window.dispatchEvent(
      new CustomEvent('sdc:review-handoff', {
        detail: {
          url: opts.url,
          reviewText: opts.reviewText,
          rating: opts.rating,
          timestamp: Date.now(),
        },
      }),
    );
  } catch {
    /* ignore */
  }

  const copied = opts.alreadyCopied ? true : await copyText(opts.reviewText);

  if (!copied) {
    return {
      mode: 'clipboard_blocked_manual_copy',
      copied: false,
      tabOpened: false,
      domPrefilled: false,
      writeReviewClicked: false,
      stoppedBeforeSubmit: true,
      statusMessage:
        "We couldn't access your clipboard automatically. Use the Copy Review button below, then open Google Reviews.",
    };
  }

  const opener = opts.openWindow ?? ((u: string) => window.open(u, '_blank'));
  let popup: Window | null;
  try {
    popup = opener(opts.url);
  } catch {
    popup = null;
  }

  if (!popup) {
    return {
      mode: 'popup_blocked_manual_proceed',
      copied: true,
      tabOpened: false,
      domPrefilled: false,
      writeReviewClicked: false,
      stoppedBeforeSubmit: true,
      statusMessage:
        'Review copied to clipboard! Your browser blocked the new tab—click "Proceed to Google Reviews" below to open and paste.',
    };
  }

  // Attempt safe DOM automation if the opened browsing context permits same-origin inspection.
  // Cross-origin google.com windows throw SecurityError on document access and immediately
  // fall through to the clipboard-assisted mode without error.
  const domResult = await tryAutomateAccessibleReviewModal(popup, {
    reviewText: opts.reviewText,
    rating: opts.rating,
    timeoutMs: opts.domTimeoutMs ?? 350,
  });

  if (domResult.prefilled) {
    return {
      mode: 'dom_prefilled_awaiting_user_post',
      copied: true,
      tabOpened: true,
      domPrefilled: true,
      writeReviewClicked: domResult.writeReviewClicked,
      stoppedBeforeSubmit: true,
      statusMessage:
        'Your review has been prefilled in the Google review box (and copied to your clipboard). Please review it and click Post on Google to publish.',
    };
  }

  return {
    mode: 'clipboard_copied_tab_opened',
    copied: true,
    tabOpened: true,
    domPrefilled: false,
    writeReviewClicked: domResult.writeReviewClicked,
    stoppedBeforeSubmit: true,
    statusMessage:
      'Review copied to clipboard! Opening Google Reviews—simply press Paste (Ctrl+V / Cmd+V) and click Post.',
  };
}
