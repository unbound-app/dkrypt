import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.API_KEY ??= 'test-api-key';
process.env.DOWNLOAD_SIGNING_SECRET ??= 'test-signing-secret';
process.env.ADMIN_PASSWORD ??= 'test-admin-password';

// Always a fresh temp dir, never `??=` - Bun auto-loads the project .env before this preload
// script runs, so a real dev .env's STATE_DIR/OUTPUT_DIR would otherwise win and tests would
// read and write the actual local dev state (confirmed: it did, before this fix).
process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'ipadecrypt-test-state-'));
process.env.OUTPUT_DIR = mkdtempSync(path.join(tmpdir(), 'ipadecrypt-test-output-'));
