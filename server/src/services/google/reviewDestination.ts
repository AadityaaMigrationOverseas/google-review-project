/**
 * Google integration boundary.
 *
 * Verified against Google's Business Profile API reference (Oct 2026): the
 * Reviews API can only LIST reviews and manage the OWNER'S REPLY. There is no
 * endpoint to create a review, no URL parameter to prefill review text, and no
 * callback confirming a review was posted. The only supported way to start a
 * review is to send the patient to Google's own "Write a review" UI, signed in
 * to their own account. Everything beyond that (reading reviews, replying)
 * needs an approved Google Cloud project + OAuth credentials and is out of
 * scope here; this module is the single place such a client would plug in.
 */

const WRITE_REVIEW_HOST = 'search.google.com';
const ALLOWED_HOSTS = new Set([
  'share.google',
  'g.page',
  'goo.gl',
  'maps.app.goo.gl',
  'search.google.com',
  'www.google.com',
  'google.com',
  'maps.google.com',
]);
const PLACE_ID = /^[A-Za-z0-9_-]{10,}$/;

export type DestinationKind = 'write_review' | 'share_link';

export interface GoogleReviewDestination {
  url: string;
  kind: DestinationKind;
  capabilities: {
    /** Google offers no API or URL parameter to prefill review text or stars. */
    prefill: false;
    /** Google does not notify third parties when a review is posted. */
    confirmation: false;
    /** Reviews can only be written by the patient in Google's UI. */
    postOnBehalf: false;
  };
}

export class GoogleReviewDestinationService {
  private readonly destination: GoogleReviewDestination;

  constructor(opts: { reviewUrl: string; placeId?: string | null }) {
    const extractedPlaceId = opts.placeId ?? GoogleReviewDestinationService.extractPlaceId(opts.reviewUrl);
    const url = extractedPlaceId ? GoogleReviewDestinationService.writeReviewUrl(extractedPlaceId) : opts.reviewUrl;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
      throw new Error(`Google review destination must be an https Google URL, got ${parsed.origin}`);
    }
    this.destination = {
      url,
      kind:
        parsed.hostname === WRITE_REVIEW_HOST && parsed.pathname.includes('writereview')
          ? 'write_review'
          : 'share_link',
      capabilities: { prefill: false, confirmation: false, postOnBehalf: false },
    };
  }

  /** Extracts a `placeid` query parameter if present on a Google Maps / write-review URL. */
  static extractPlaceId(rawUrl: string): string | null {
    try {
      const parsed = new URL(rawUrl);
      const pid = parsed.searchParams.get('placeid') ?? parsed.searchParams.get('place_id');
      return pid && PLACE_ID.test(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  /** Deep link that opens Google's review dialog directly (the `newReviewUrl` form from the Business Profile API). */
  static writeReviewUrl(placeId: string): string {
    if (!PLACE_ID.test(placeId)) throw new Error('GOOGLE_PLACE_ID has an unexpected format');
    return `https://${WRITE_REVIEW_HOST}/local/writereview?placeid=${encodeURIComponent(placeId)}`;
  }

  get(): GoogleReviewDestination {
    return this.destination;
  }

  get url(): string {
    return this.destination.url;
  }

  get kind(): DestinationKind {
    return this.destination.kind;
  }
}
