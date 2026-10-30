import { loadConfig } from '../config/env.js';
import { openDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrate.js';
import { systemClock } from '../lib/clock.js';
import { createLogger } from '../lib/createLogger.js';
import { AuditRepository } from '../repositories/auditRepository.js';
import { ComplaintRepository } from '../repositories/complaintRepository.js';
import { ReviewRepository } from '../repositories/reviewRepository.js';
import { SessionRepository } from '../repositories/sessionRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { AuthService } from '../services/auth/authService.js';
import { PasswordHasher } from '../services/auth/password.js';
import { RetentionService } from '../services/retentionService.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
runMigrations(db);
const auth = new AuthService(new UserRepository(db), new SessionRepository(db), new PasswordHasher(), systemClock, {
  sessionTtlMs: config.session.ttlMs,
  sessionIdleMs: config.session.idleMs,
});
const retention = new RetentionService(
  new ReviewRepository(db),
  new ComplaintRepository(db),
  new AuditRepository(db),
  auth,
  systemClock,
  createLogger('info'),
  config.retention,
);
console.log(JSON.stringify(retention.purge()));
db.close();
