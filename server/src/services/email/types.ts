export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  /** Stable per logical message so receivers can drop duplicates after a retry. */
  messageId: string;
  headers?: Record<string, string>;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<{ messageId: string | null }>;
  verify?(): Promise<void>;
  close?(): void;
}

/** Delivery failures that retrying cannot fix (e.g. recipient rejected). */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEmailError';
  }
}
