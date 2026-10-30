import type {
  ComplaintStatus,
  NotificationStatus,
  Permission,
  Role,
  SentimentLabel,
  SentimentStatus,
} from './constants.js';
import type { ReviewNextStep, ReviewRoutingStatus } from './routing.js';
import type { FieldErrors } from './validation.js';

/** Fields every public form submission carries in addition to its payload. */
export interface AntiSpamFields {
  formToken?: string;
  /** Honeypot: must stay empty. */
  website?: string;
}

export type GoogleDestinationKind = 'write_review' | 'share_link';

export interface GoogleReviewCapabilities {
  /** Whether the destination URL directly opens Google's "Write a review" composer modal (`newReviewUrl`). */
  opensWriteReviewModal: boolean;
  /** Cross-origin DOM injection into google.com is blocked by browser Same-Origin Policy; false unless same-origin. */
  crossOriginDomPrefill: false;
  /** Google offers no API or URL parameter to prefill review text or stars. */
  prefill: false;
  /** Google does not notify third parties when a review is posted. */
  confirmation: false;
  /** Reviews can only be published by the patient in Google's UI. */
  postOnBehalf: false;
}

export interface FormTokenResponse {
  formToken: string;
  googleReviewUrl: string;
  googleDestinationKind?: GoogleDestinationKind;
  googleCapabilities?: GoogleReviewCapabilities;
  consentVersion: string;
}

export interface SentimentPreviewRequest {
  sessionId?: string;
  reviewText?: string;
  text?: string;
}

export interface SentimentPreviewResponse {
  sessionId: string | null;
  label: 'POSITIVE' | 'NEGATIVE' | null;
  sentiment: SentimentLabel | null;
  confidence: number | null;
  cached: boolean;
  latencyMs: number | null;
}

export interface SubmitReviewRequest extends AntiSpamFields {
  sessionId?: string;
  rating: number;
  text?: string;
  reviewText?: string;
  consent?: boolean;
  linkCode?: string | null;
  /** Client UUID; a retry with the same key returns the original result instead of a duplicate. */
  idempotencyKey?: string;
}

export interface SubmitReviewResponse {
  id: number;
  reviewId?: string;
  status?: ReviewRoutingStatus;
  googleUrl?: string;
  googleReviewUrl: string;
  googleDestinationKind?: GoogleDestinationKind;
  googleCapabilities?: GoogleReviewCapabilities;
  /** C++ engine verdict; null when the engine was unavailable. */
  sentiment: SentimentLabel | null;
  next: ReviewNextStep;
  /** True when this request replayed an earlier submission with the same idempotency key. */
  duplicate: boolean;
}

export interface SubmitComplaintRequest extends AntiSpamFields {
  sessionId?: string;
  reviewId?: string | number;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone: string;
  rating: number;
  details?: string;
  reviewText?: string;
  consent?: boolean;
  idempotencyKey?: string;
}

export interface SubmitComplaintResponse {
  reference: string;
  status?: 'RESOLVED_QUEUED';
  message?: string;
}

export interface ApiError {
  error: string;
  message: string;
  fields?: FieldErrors<string>;
}

export interface StaffUserDto {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface SessionDto {
  user: StaffUserDto;
  permissions: Permission[];
  csrfToken: string;
}

export interface ReviewDto {
  id: number;
  rating: number;
  text: string;
  sentiment: SentimentLabel | null;
  sentimentConfidence: number | null;
  sentimentStatus: SentimentStatus;
  sentimentLatencyMs: number | null;
  /** Rating and model sentiment disagree strongly (e.g. 5 stars, negative text). */
  mismatch: boolean;
  linkCode: string | null;
  linkLabel: string | null;
  createdAt: number;
}

export interface ComplaintDto {
  id: number;
  reference: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** False when contact details have been masked for the current role. */
  piiVisible: boolean;
  rating: number;
  details: string;
  status: ComplaintStatus;
  notificationStatus: NotificationStatus | null;
  notificationAttempts: number;
  notificationError: string | null;
  notificationSentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ShortLinkDto {
  id: number;
  code: string;
  url: string;
  label: string;
  source: string | null;
  disabled: boolean;
  expiresAt: number | null;
  clickCount: number;
  reviewCount: number;
  lastClickedAt: number | null;
  createdAt: number;
  createdBy: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: number | null;
}

export interface StatsDto {
  reviews: {
    total: number;
    averageRating: number | null;
    byRating: Record<string, number>;
    bySentiment: Record<SentimentLabel | 'unanalyzed', number>;
    last7Days: number;
  };
  complaints: { total: number; open: number; inProgress: number; resolved: number };
  notifications: { pending: number; failed: number; sent: number };
  sentimentEngine: { ready: boolean; workers: number; p50Ms: number | null; p95Ms: number | null };
}
