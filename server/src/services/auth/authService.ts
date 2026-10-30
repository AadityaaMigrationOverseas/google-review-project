import { isValidEmail, type Role, type StaffUserDto } from '@stellar/shared';
import type { Clock } from '../../lib/clock.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import type { SessionRepository } from '../../repositories/sessionRepository.js';
import type { UserRepository, UserRow } from '../../repositories/userRepository.js';
import { isUniqueViolation } from '../../db/database.js';
import { validatePasswordStrength, type PasswordHasher } from './password.js';

export interface AuthenticatedSession {
  user: StaffUserDto;
  tokenHash: string;
  csrfToken: string;
}

export interface AuthOptions {
  sessionTtlMs: number;
  sessionIdleMs: number;
  maxFailedLogins?: number;
  lockoutMs?: number;
}

const TOUCH_INTERVAL_MS = 60_000;

export function toUserDto(u: UserRow): StaffUserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    disabled: u.disabled === 1,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

export class AuthService {
  private readonly maxFailed: number;
  private readonly lockoutMs: number;

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly opts: AuthOptions,
  ) {
    this.maxFailed = opts.maxFailedLogins ?? 5;
    this.lockoutMs = opts.lockoutMs ?? 15 * 60_000;
  }

  async login(
    email: unknown,
    password: unknown,
    meta: { ipHash: string | null; userAgent: string | null },
  ): Promise<{ token: string; session: AuthenticatedSession }> {
    const invalid = unauthorized('Incorrect email or password.');
    if (typeof email !== 'string' || typeof password !== 'string' || password.length > 256) throw invalid;

    const user = this.users.findByEmail(email.trim().toLowerCase());
    const now = this.clock.now();
    if (!user || user.disabled === 1) {
      await this.hasher.burn(password);
      throw invalid;
    }
    if (user.locked_until && user.locked_until > now) {
      await this.hasher.burn(password);
      throw new AppError(423, 'locked', 'Too many failed attempts. Please try again in 15 minutes.');
    }
    if (!(await this.hasher.verify(password, user.password_hash))) {
      const lock = user.failed_logins + 1 >= this.maxFailed ? now + this.lockoutMs : null;
      this.users.recordFailedLogin(user.id, lock);
      throw invalid;
    }

    this.users.recordSuccessfulLogin(user.id, now);
    const token = randomToken(32);
    const tokenHash = sha256(token);
    const csrfToken = randomToken(32);
    this.sessions.insert({
      token_hash: tokenHash,
      user_id: user.id,
      csrf_token: csrfToken,
      created_at: now,
      last_seen_at: now,
      expires_at: now + this.opts.sessionTtlMs,
      ip_hash: meta.ipHash,
      user_agent: meta.userAgent?.slice(0, 200) ?? null,
    });
    return {
      token,
      session: { user: toUserDto({ ...user, last_login_at: now }), tokenHash, csrfToken },
    };
  }

  authenticate(token: string | undefined): AuthenticatedSession | null {
    if (!token || token.length > 100) return null;
    const tokenHash = sha256(token);
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
    const now = this.clock.now();
    if (session.expires_at <= now || session.last_seen_at + this.opts.sessionIdleMs <= now) {
      this.sessions.delete(tokenHash);
      return null;
    }
    const user = this.users.findById(session.user_id);
    if (!user || user.disabled === 1) {
      this.sessions.delete(tokenHash);
      return null;
    }
    if (now - session.last_seen_at > TOUCH_INTERVAL_MS) this.sessions.touch(tokenHash, now);
    return { user: toUserDto(user), tokenHash, csrfToken: session.csrf_token };
  }

  logout(tokenHash: string): void {
    this.sessions.delete(tokenHash);
  }

  purgeExpiredSessions(): number {
    const now = this.clock.now();
    return this.sessions.deleteExpired(now, now - this.opts.sessionIdleMs);
  }

  async createUser(input: { email: unknown; name: unknown; password: unknown; role: Role }): Promise<StaffUserDto> {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    const fields: Record<string, string> = {};
    if (!isValidEmail(email)) fields.email = 'Enter a valid email address.';
    if (name.length < 2 || name.length > 80) fields.name = 'Enter a name between 2 and 80 characters.';
    const pwError = validatePasswordStrength(password);
    if (pwError) fields.password = pwError;
    if (Object.keys(fields).length) throw badRequest('Please check the highlighted fields.', fields);

    try {
      const id = this.users.insert({
        email,
        name,
        passwordHash: await this.hasher.hash(password),
        role: input.role,
        now: this.clock.now(),
      });
      return toUserDto(this.users.findById(id)!);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A staff account with that email already exists.');
      throw err;
    }
  }

  listUsers(): StaffUserDto[] {
    return this.users.list().map(toUserDto);
  }

  updateUser(actorId: number, id: number, patch: { role?: Role; disabled?: boolean }): StaffUserDto {
    const user = this.users.findById(id);
    if (!user) throw notFound('Staff account not found.');
    const losingAdmin =
      user.role === 'admin' &&
      user.disabled === 0 &&
      (patch.disabled === true || (patch.role && patch.role !== 'admin'));
    if (losingAdmin && this.users.countActiveAdmins() <= 1)
      throw conflict('At least one active administrator is required.');
    if (actorId === id && patch.disabled === true) throw conflict('You cannot disable your own account.');

    this.users.update(id, patch);
    // Privilege changes take effect immediately.
    if (patch.disabled !== undefined || patch.role !== undefined) this.sessions.deleteForUser(id);
    return toUserDto(this.users.findById(id)!);
  }
}
