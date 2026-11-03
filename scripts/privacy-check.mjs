import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const publicRoots = ['.gitignore', '.npmignore', '.env.example', 'README.md', 'package.json',
  'package-lock.json', 'config.example.json', 'src', 'scripts', 'test', 'clients'];

export function isPrivatePath(path) {
  const parts = path.replaceAll('\\', '/').split('/');
  const name = parts.at(-1);
  return parts.some(part => ['data', 'work', 'node_modules', 'dist', '.git'].includes(part))
    || (name.startsWith('.env') && name !== '.env.example')
    || name === '.npmrc'
    || /\.local\.(json|ya?ml)$/i.test(name)
    || /\.(sqlite|db)(-.*)?$/i.test(name)
    || /\.(log|bak|tgz|zip|pem|key)$/i.test(name);
}

export function publicFiles(root) {
  const files = [];
  function walk(path) {
    if (!existsSync(path)) return;
    if (lstatSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
    } else files.push(path);
  }
  for (const name of publicRoots) walk(join(root, name));
  return files;
}

export function knownPrivateValues(root) {
  const configFile = join(root, 'config.local.json');
  const envFile = join(root, '.env');
  const local = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) : {};
  const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const values = [local.deviceKey, env.BARK_DEVICE_KEY, process.env.BARK_DEVICE_KEY]
    .filter(value => value && !/REPLACE|YOUR_|FAKE|TEST/i.test(value));
  for (const address of [local.serverUrl, env.BARK_SERVER_URL, process.env.BARK_SERVER_URL]) {
    if (!address) continue;
    const host = new URL(address).hostname;
    if (!/^(api\.day\.app|localhost|127\.0\.0\.1)$/.test(host) && !/\.(example|invalid)$/.test(host)) values.push(host);
  }
  return values;
}

export function auditFiles(root, { secrets = [], trackedPaths = [] } = {}) {
  root = resolve(root);
  const findings = [];
  const files = publicFiles(root);
  const paths = [root, homedir()].flatMap(path => [path, path.replaceAll('\\', '/'), path.replaceAll('\\', '\\\\')]);
  for (const file of files) {
    const name = relative(root, file).replaceAll('\\', '/');
    if (lstatSync(file).isSymbolicLink()) { findings.push({ file: name, reason: 'symbolic_link' }); continue; }
    if (isPrivatePath(name)) { findings.push({ file: name, reason: 'private_file_in_public_directory' }); continue; }
    const text = readFileSync(file, 'utf8');
    if (secrets.some(value => value && text.includes(value))) findings.push({ file: name, reason: 'known_private_value' });
    if (paths.some(value => text.includes(value))) findings.push({ file: name, reason: 'personal_absolute_path' });
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/.test(text)
      || /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text)) findings.push({ file: name, reason: 'credential_pattern' });
  }
  for (const file of trackedPaths) {
    if (isPrivatePath(file)) findings.push({ file, reason: 'private_file_already_tracked_by_git' });
  }
  return { ok: findings.length === 0, checked_files: files.length, findings };
}

export function checkPrivacy(root = fileURLToPath(new URL('../', import.meta.url))) {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const trackedPaths = tracked.status === 0 ? tracked.stdout.split('\0').filter(Boolean) : [];
  return auditFiles(root, { secrets: knownPrivateValues(root), trackedPaths });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = checkPrivacy();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch {
    console.error('Privacy check could not complete. Check local configuration syntax; no secret values were printed.');
    process.exitCode = 1;
  }
}
