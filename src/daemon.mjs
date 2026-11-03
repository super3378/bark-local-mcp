import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createBarkTools } from './bark.mjs';
import { validateConfig } from './config.mjs';
import { ReminderStore, getDataDir } from './store.mjs';

export async function runScheduler(dataDir = getDataDir(), { send, signal } = {}) {
  const store = new ReminderStore(dataDir);
  const owner = randomUUID();
  if (!store.acquire(owner, process.pid)) { store.close(); return; }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  signal?.addEventListener('abort', stop, { once: true });
  const heartbeat = setInterval(() => {
    try { if (!store.heartbeat(owner)) stopping = true; }
    catch { stopping = true; }
  }, 5000);
  try {
    while (!stopping && !signal?.aborted) {
      const row = store.claim(owner);
      if (!row) { await delay(1000); continue; }
      let outcome;
      try {
        const args = JSON.parse(row.args_json);
        const config = validateConfig(JSON.parse(row.connection_json));
        const response = send ? await send(args, config) : await createBarkTools(config).sendNotification(args);
        outcome = response.structuredContent;
        if (!outcome || !['accepted', 'rejected', 'unknown', 'not_sent'].includes(outcome.status)) {
          outcome = { ok: false, status: 'unknown', error: 'unexpected_sender_result' };
        }
      } catch {
        outcome = { ok: false, status: 'unknown', error: 'sender_interrupted', delivery_confirmed: false };
      }
      store.finish(row.id, owner, outcome);
    }
  } finally {
    clearInterval(heartbeat);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    signal?.removeEventListener('abort', stop);
    try { store.release(owner); } finally { store.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--data-dir');
  runScheduler(index === -1 ? getDataDir() : process.argv[index + 1]).catch(() => {
    process.stderr.write('Bark reminder background process stopped unexpectedly. Pending reminders remain saved.\n');
    process.exitCode = 1;
  });
}
