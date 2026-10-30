import type { Role } from '@stellar/shared';
import type { Database } from '../db/database.js';

export interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  disabled: number;
  failed_logins: number;
  locked_until: number | null;
  created_at: number;
  last_login_at: number | null;
}

export class UserRepository {
  constructor(private readonly db: Database) {}

  insert(u: { email: string; name: string; passwordHash: string; role: Role; now: number }): number {
    return Number(
      this.db
        .prepare('INSERT INTO staff_users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(u.email, u.name, u.passwordHash, u.role, u.now).lastInsertRowid,
    );
  }

  findByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM staff_users WHERE email = ?').get(email) as UserRow | undefined;
  }

  findById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM staff_users WHERE id = ?').get(id) as UserRow | undefined;
  }

  list(): UserRow[] {
    return this.db.prepare('SELECT * FROM staff_users ORDER BY id').all() as unknown as UserRow[];
  }

  recordFailedLogin(id: number, lockUntil: number | null): void {
    this.db
      .prepare(
        'UPDATE staff_users SET failed_logins = failed_logins + 1, locked_until = COALESCE(?, locked_until) WHERE id = ?',
      )
      .run(lockUntil, id);
  }

  recordSuccessfulLogin(id: number, now: number): void {
    this.db
      .prepare('UPDATE staff_users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
      .run(now, id);
  }

  update(id: number, patch: { role?: Role; disabled?: boolean; passwordHash?: string }): boolean {
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (patch.role) {
      sets.push('role = ?');
      params.push(patch.role);
    }
    if (patch.disabled !== undefined) {
      sets.push('disabled = ?');
      params.push(patch.disabled ? 1 : 0);
    }
    if (patch.passwordHash) {
      sets.push('password_hash = ?, failed_logins = 0, locked_until = NULL');
      params.push(patch.passwordHash);
    }
    if (sets.length === 0) return false;
    params.push(id);
    return this.db.prepare(`UPDATE staff_users SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
  }

  countActiveAdmins(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM staff_users WHERE role = 'admin' AND disabled = 0").get() as {
        n: number;
      }
    ).n;
  }
}
