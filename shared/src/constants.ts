export const CLINIC = {
  name: 'Stellar Dental Clinic',
  doctorName: 'Dr. Dhruvi Shah',
  doctorTitle: 'Lead Dentist',
} as const;

/** Bump whenever consent wording on the public forms changes. */
export const CONSENT_VERSION = '2026-11-v2';

export const LIMITS = {
  reviewTextMin: 5,
  reviewTextMax: 2000,
  complaintDetailsMin: 5,
  complaintDetailsMax: 4000,
  nameMax: 60,
  fullNameMax: 120,
  emailMax: 254,
  phoneDigitsMin: 7,
  phoneDigitsMax: 15,
  linkLabelMax: 80,
  linkSourceMax: 40,
} as const;

export const SHORT_CODE_PATTERN = /^[A-Za-z0-9]{6,16}$/;

export const RATING_LABELS: Record<number, string> = {
  1: 'Very poor',
  2: 'Poor',
  3: 'Okay',
  4: 'Good',
  5: 'Excellent',
};

/**
 * positive / negative: confident model verdict. neutral: the model leaned one
 * way but below the confidence bar. uncertain: too close to call, or the
 * engine's output failed validation.
 */
export const SENTIMENT_LABELS = ['positive', 'negative', 'neutral', 'uncertain'] as const;
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

export const SENTIMENT_STATUSES = ['pending', 'analyzed', 'skipped', 'failed'] as const;
export type SentimentStatus = (typeof SENTIMENT_STATUSES)[number];

export const COMPLAINT_STATUSES = ['open', 'in_progress', 'resolved'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const NOTIFICATION_STATUSES = ['pending', 'sending', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const ROLES = ['admin', 'manager', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'reviews:read',
  'complaints:read',
  'complaints:read_pii',
  'complaints:update',
  'notifications:retry',
  'links:read',
  'links:write',
  'users:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
