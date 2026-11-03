import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

export const defaultConfigFile = new URL('../config.local.json', import.meta.url);
export const defaultEnvFile = new URL('../.env', import.meta.url);

export function loadEnvironment(env = process.env) {
  let local = {};
  try {
    local = parseEnv(readFileSync(env.BARK_ENV_FILE || defaultEnvFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read Bark env file');
  }
  // Read configuration only; never inject arbitrary .env entries into process.env.
  return { ...local, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) };
}

const configSchema = z.object({
  serverUrl: z.string().url(),
  deviceKey: z.string().regex(/^[A-Za-z0-9]+$/, 'Device key must be alphanumeric'),
  defaultGroup: z.string().max(200).default('Codex'),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
});

export function validateConfig(raw) {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path[0]))];
    throw new Error(`Invalid Bark configuration fields: ${fields.join(', ')}`);
  }
  const config = parsed.data;
  const url = new URL(config.serverUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Bark server requires HTTPS (HTTP is allowed only for loopback tests)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Bark server URL must not contain credentials, query parameters or fragments');
  }
  config.serverUrl = config.serverUrl.replace(/\/+$/, '');
  return Object.freeze(config);
}

export function loadConfig(env = process.env) {
  const settings = loadEnvironment(env);
  const file = settings.BARK_CONFIG_FILE || defaultConfigFile;
  let local = {};
  try {
    local = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error();
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read Bark config: expected a UTF-8 JSON object');
  }
  return validateConfig({
    serverUrl: settings.BARK_SERVER_URL ?? local.serverUrl,
    deviceKey: settings.BARK_DEVICE_KEY ?? local.deviceKey,
    defaultGroup: settings.BARK_DEFAULT_GROUP ?? local.defaultGroup,
    timeoutMs: settings.BARK_TIMEOUT_MS === undefined ? local.timeoutMs : Number(settings.BARK_TIMEOUT_MS),
  });
}
