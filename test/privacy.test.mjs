import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { auditFiles, isPrivatePath } from '../scripts/privacy-check.mjs';
import { loadConfig, loadEnvironment } from '../src/config.mjs';
import { getDataDir } from '../src/store.mjs';

const work = fileURLToPath(new URL('../work/', import.meta.url));
mkdirSync(work, { recursive: true });

test('private env configuration works without JSON and never mutates the parent environment', () => {
  const root = mkdtempSync(join(work, 'env-test-'));
  const dotenv = join(root, '.env');
  const legacy = join(root, 'config.local.json');
  writeFileSync(legacy, JSON.stringify({ serverUrl: 'https://legacy.invalid', deviceKey: 'LEGACYKEY', defaultGroup: 'Legacy' }));
  writeFileSync(dotenv, 'BARK_SERVER_URL=https://env.invalid\nBARK_DEVICE_KEY="ENVKEY123"\nBARK_DEFAULT_GROUP="测试分组"\nBARK_TIMEOUT_MS=1234\nBARK_DATA_DIR="' + root.replaceAll('\\', '/') + '"\n');
  const env = { BARK_ENV_FILE: dotenv, BARK_CONFIG_FILE: legacy };
  assert.equal(loadConfig(env).deviceKey, 'ENVKEY123');
  assert.equal(loadConfig(env).defaultGroup, '测试分组');
  assert.equal(loadConfig(env).timeoutMs, 1234);
  assert.equal(loadConfig({ ...env, BARK_DEVICE_KEY: 'OSKEY123' }).deviceKey, 'OSKEY123');
  assert.equal(loadConfig({ ...env, BARK_CONFIG_FILE: join(root, 'missing.json') }).serverUrl, 'https://env.invalid');
  assert.equal(loadConfig({ ...env, BARK_ENV_FILE: join(root, 'missing.env') }).deviceKey, 'LEGACYKEY');
  assert.equal(getDataDir(env), root);
  assert.equal(env.BARK_DEVICE_KEY, undefined);
  assert.equal(loadEnvironment({ ...env, BARK_TIMEOUT_MS: undefined }).BARK_TIMEOUT_MS, '1234');
});

test('invalid credentials fail without putting the configured value into the error message', () => {
  const root = mkdtempSync(join(work, 'invalid-env-'));
  const dotenv = join(root, '.env');
  const invalid = 'SECRET' + '-invalid-key';
  writeFileSync(dotenv, 'BARK_SERVER_URL=https://example.invalid\nBARK_DEVICE_KEY=' + invalid);
  assert.throws(() => loadConfig({ BARK_ENV_FILE: dotenv, BARK_CONFIG_FILE: join(root, 'missing.json') }),
    error => !error.message.includes(invalid) && error.message.includes('deviceKey'));
});

test('privacy audit detects source leaks and tracked private files while keeping reports redacted', () => {
  const root = mkdtempSync(join(work, 'privacy-audit-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.env.example'), 'BARK_DEVICE_KEY=REPLACE_WITH_YOUR_DEVICE_KEY\n');
  const secret = 'private' + 'DeviceKey123';
  writeFileSync(join(root, 'src', 'leak.mjs'), secret + '\n' + root + '\n' + 'ghp_' + 'X'.repeat(40));
  const report = auditFiles(root, { secrets: [secret], trackedPaths: ['.env', 'data/reminders.sqlite', 'work/backup.json'] });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some(x => x.reason === 'known_private_value'));
  assert.ok(report.findings.some(x => x.reason === 'personal_absolute_path'));
  assert.ok(report.findings.some(x => x.reason === 'credential_pattern'));
  assert.equal(report.findings.filter(x => x.reason === 'private_file_already_tracked_by_git').length, 3);
  assert.equal(JSON.stringify(report).includes(secret), false);
  writeFileSync(join(root, 'src', 'leak.mjs'), 'export const version = 1;');
  assert.equal(auditFiles(root).ok, true);
  assert.equal(isPrivatePath('.env.example'), false);
  for (const path of ['.env.production', 'config.local.yaml', 'data/reminders.sqlite-wal', 'export.db', 'debug.log']) {
    assert.equal(isPrivatePath(path), true);
  }
});
