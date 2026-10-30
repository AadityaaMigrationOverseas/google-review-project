import { isValidShortCode, LIMITS, normalizeText, type ShortLinkDto } from '@stellar/shared';
import QRCode from 'qrcode';
import { isUniqueViolation } from '../db/database.js';
import type { Clock } from '../lib/clock.js';
import { randomBase62 } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { ShortLinkRepository, ShortLinkRow } from '../repositories/shortLinkRepository.js';

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 5_000;

export interface ShortLinkOptions {
  baseUrl: string;
  codeLength: number;
}

export class ShortLinkService {
  /** Caches code -> link id (or null for unknown) to keep hot QR/WhatsApp links off the DB. */
  private readonly cache = new Map<string, { id: number | null; expiresAt: number }>();

  constructor(
    private readonly repo: ShortLinkRepository,
    private readonly clock: Clock,
    private readonly opts: ShortLinkOptions,
  ) {}

  urlFor(code: string): string {
    return `${this.opts.baseUrl}/${code}`;
  }

  /** Returns the active link id for a code, or null if unknown, disabled or expired. */
  resolve(code: string): number | null {
    if (!isValidShortCode(code)) return null;
    const now = this.clock.now();
    const hit = this.cache.get(code);
    if (hit && hit.expiresAt > now) return hit.id;
    const id = this.repo.findActiveIdByCode(code, now);
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(code, { id, expiresAt: now + CACHE_TTL_MS });
    return id;
  }

  recordClick(id: number): void {
    this.repo.recordClick(id, this.clock.now());
  }

  create(
    input: { label?: unknown; source?: unknown; expiresInDays?: unknown },
    createdBy: number | null,
  ): ShortLinkDto {
    const label = normalizeText(typeof input.label === 'string' ? input.label : '');
    const source = normalizeText(typeof input.source === 'string' ? input.source : '') || null;
    const fields: Record<string, string> = {};
    if (label.length < 2 || label.length > LIMITS.linkLabelMax)
      fields.label = `Label must be 2–${LIMITS.linkLabelMax} characters.`;
    if (source && source.length > LIMITS.linkSourceMax)
      fields.source = `Source must be at most ${LIMITS.linkSourceMax} characters.`;
    let expiresAt: number | null = null;
    if (input.expiresInDays !== undefined && input.expiresInDays !== null && input.expiresInDays !== '') {
      const days = Number(input.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 3650) fields.expiresInDays = 'Expiry must be 1–3650 days.';
      else expiresAt = this.clock.now() + days * 86_400_000;
    }
    if (Object.keys(fields).length) throw badRequest('Please check the highlighted fields.', fields);

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const id = this.repo.insert({
          code: randomBase62(this.opts.codeLength),
          label,
          source,
          expiresAt,
          createdBy,
          now: this.clock.now(),
        });
        return this.get(id);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new Error('could not allocate a unique short code');
  }

  get(id: number): ShortLinkDto {
    const row = this.repo.findById(id);
    if (!row) throw notFound('Link not found.');
    return this.toDto(row);
  }

  list(limit = 200): ShortLinkDto[] {
    return this.repo.list(limit).map((r) => this.toDto(r));
  }

  update(id: number, patch: { disabled?: unknown; label?: unknown }): ShortLinkDto {
    const next: { disabled?: boolean; label?: string } = {};
    if (patch.disabled !== undefined) {
      if (typeof patch.disabled !== 'boolean') throw badRequest('disabled must be true or false.');
      next.disabled = patch.disabled;
    }
    if (patch.label !== undefined) {
      const label = normalizeText(typeof patch.label === 'string' ? patch.label : '');
      if (label.length < 2 || label.length > LIMITS.linkLabelMax) throw badRequest('Invalid label.');
      next.label = label;
    }
    if (!this.repo.findById(id)) throw notFound('Link not found.');
    this.repo.update(id, next);
    this.cache.clear();
    return this.get(id);
  }

  async qrSvg(id: number): Promise<string> {
    const link = this.get(id);
    return QRCode.toString(link.url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      color: { dark: '#0b3d3a', light: '#ffffff' },
    });
  }

  private toDto(r: ShortLinkRow): ShortLinkDto {
    return {
      id: r.id,
      code: r.code,
      url: this.urlFor(r.code),
      label: r.label,
      source: r.source,
      disabled: r.disabled === 1,
      expiresAt: r.expires_at,
      clickCount: r.click_count,
      reviewCount: r.review_count,
      lastClickedAt: r.last_clicked_at,
      createdAt: r.created_at,
      createdBy: r.created_by_name,
    };
  }
}
