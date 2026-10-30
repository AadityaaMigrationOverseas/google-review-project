import type { Database } from '../db/database.js';

export interface ShortLinkRow {
  id: number;
  code: string;
  label: string;
  source: string | null;
  disabled: number;
  expires_at: number | null;
  click_count: number;
  last_clicked_at: number | null;
  created_at: number;
  created_by_name: string | null;
  review_count: number;
}

export interface NewShortLink {
  code: string;
  label: string;
  source: string | null;
  expiresAt: number | null;
  createdBy: number | null;
  now: number;
}

const SELECT = `
  SELECT l.id, l.code, l.label, l.source, l.disabled, l.expires_at, l.click_count, l.last_clicked_at,
         l.created_at, u.name AS created_by_name,
         (SELECT COUNT(*) FROM reviews r WHERE r.short_link_id = l.id) AS review_count
  FROM short_links l LEFT JOIN staff_users u ON u.id = l.created_by`;

export class ShortLinkRepository {
  private readonly activeByCodeStmt;
  private readonly clickStmt;

  constructor(private readonly db: Database) {
    this.activeByCodeStmt = db.prepare(`
      SELECT id FROM short_links
      WHERE code = ? AND disabled = 0 AND (expires_at IS NULL OR expires_at > ?)`);
    this.clickStmt = db.prepare(
      'UPDATE short_links SET click_count = click_count + 1, last_clicked_at = ? WHERE id = ?',
    );
  }

  insert(l: NewShortLink): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO short_links (code, label, source, expires_at, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(l.code, l.label, l.source, l.expiresAt, l.createdBy, l.now).lastInsertRowid,
    );
  }

  findActiveIdByCode(code: string, now: number): number | null {
    const row = this.activeByCodeStmt.get(code, now) as { id: number } | undefined;
    return row?.id ?? null;
  }

  recordClick(id: number, now: number): void {
    this.clickStmt.run(now, id);
  }

  findById(id: number): ShortLinkRow | undefined {
    return this.db.prepare(`${SELECT} WHERE l.id = ?`).get(id) as ShortLinkRow | undefined;
  }

  list(limit: number): ShortLinkRow[] {
    return this.db.prepare(`${SELECT} ORDER BY l.id DESC LIMIT ?`).all(limit) as unknown as ShortLinkRow[];
  }

  update(id: number, patch: { disabled?: boolean; label?: string; expiresAt?: number | null }): boolean {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.disabled !== undefined) {
      sets.push('disabled = ?');
      params.push(patch.disabled ? 1 : 0);
    }
    if (patch.label !== undefined) {
      sets.push('label = ?');
      params.push(patch.label);
    }
    if (patch.expiresAt !== undefined) {
      sets.push('expires_at = ?');
      params.push(patch.expiresAt);
    }
    if (sets.length === 0) return false;
    params.push(id);
    return this.db.prepare(`UPDATE short_links SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
  }
}
