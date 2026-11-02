import { copyText } from './clipboard';

/**
 * Google Reviews handoff module.
 *
 * Browsers enforce the Same-Origin Policy, so our site cannot read or type into
 * Google's cross-origin review page. This module therefore does the only thing that
 * works reliably everywhere (including on phones): it copies the exact review text to
 * the clipboard and opens Google's "Write a review" box so the patient can paste and post.
 */

export type HandoffMode =
  'clipboard_copied_tab_opened' | 'popup_blocked_manual_proceed' | 'clipboard_blocked_manual_copy';

export interface GoogleReviewHandoffOptions {
  url: string;
  reviewText: string;
  alreadyCopied?: boolean;
  /** Optional window opener override (defaults to `window.open`). */
  openWindow?: (url: string) => Window | null;
}

export interface GoogleReviewHandoffResult {
  mode: HandoffMode;
  copied: boolean;
  tabOpened: boolean;
  statusMessage: string;
}

/**
 * Executes the Google Reviews workflow:
 * 1. Copies the exact review text to the clipboard (unless already copied in the click gesture).
 * 2. Opens the Google "Write a review" destination URL in a new tab.
 * 3. Falls back to clear manual instructions when the clipboard or the popup is blocked.
 */
export async function executeGoogleReviewHandoff(opts: GoogleReviewHandoffOptions): Promise<GoogleReviewHandoffResult> {
  const copied = opts.alreadyCopied ? true : await copyText(opts.reviewText);

  if (!copied) {
    return {
      mode: 'clipboard_blocked_manual_copy',
      copied: false,
      tabOpened: false,
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
      statusMessage:
        'Review copied to clipboard! Your browser blocked the new tab—click "Proceed to Google Reviews" below to open and paste.',
    };
  }

  return {
    mode: 'clipboard_copied_tab_opened',
    copied: true,
    tabOpened: true,
    statusMessage:
      'Review copied to clipboard! Opening Google "Write a Review" dialog—press Paste (Ctrl+V / Cmd+V) and click Post.',
  };
}
