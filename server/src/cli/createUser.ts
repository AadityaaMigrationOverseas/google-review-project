import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { isRole, ROLES } from '@stellar/shared';
import { loadConfig } from '../config/env.js';
import { openDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrate.js';
import { systemClock } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { SessionRepository } from '../repositories/sessionRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { AuthService } from '../services/auth/authService.js';
import { PasswordHasher } from '../services/auth/password.js';

/** Reads a password without echoing it, unless supplied via STAFF_PASSWORD (for automation). */
async function readPassword(prompt: string): Promise<string> {
  if (process.env.STAFF_PASSWORD) return process.env.STAFF_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('No TTY: set STAFF_PASSWORD to provide the password non-interactively.');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    write(s.startsWith(prompt) ? prompt : s.replace(/[^\r\n]/g, ''));
  };
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', default: 'admin' },
    },
  });
  if (!values.email || !values.name || !isRole(values.role)) {
    console.error(
      `Usage: npm run admin:create -- --email you@clinic.com --name "Full Name" [--role ${ROLES.join('|')}]`,
    );
    process.exit(2);
  }

  const password = await readPassword('Password: ');
  if (!process.env.STAFF_PASSWORD && password !== (await readPassword('Confirm password: '))) {
    console.error('Passwords do not match.');
    process.exit(2);
  }

  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  runMigrations(db);
  const auth = new AuthService(new UserRepository(db), new SessionRepository(db), new PasswordHasher(), systemClock, {
    sessionTtlMs: config.session.ttlMs,
    sessionIdleMs: config.session.idleMs,
  });
  try {
    const user = await auth.createUser({ email: values.email, name: values.name, password, role: values.role });
    console.log(`Created ${user.role} account for ${user.email} (id ${user.id}).`);
  } catch (err) {
    if (err instanceof AppError) {
      console.error(err.message, err.fields ?? '');
      process.exit(1);
    }
    throw err;
  } finally {
    db.close();
  }
}

void main();
