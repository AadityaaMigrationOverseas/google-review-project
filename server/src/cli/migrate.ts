import { loadConfig } from '../config/env.js';
import { openDatabase } from '../db/database.js';
import { runMigrations } from '../db/migrate.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const applied = runMigrations(db);
db.close();
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
