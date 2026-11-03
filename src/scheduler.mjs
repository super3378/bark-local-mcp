import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ReminderStore, getDataDir } from './store.mjs';

export async function ensureSchedulerRunning(dataDir = getDataDir()) {
  const store = new ReminderStore(dataDir);
  try {
    if (store.running()) return store.lease().pid;
    const child = spawn(process.execPath,
      ['--use-env-proxy', fileURLToPath(new URL('./daemon.mjs', import.meta.url)), '--data-dir', store.dataDir],
      { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env } });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.unref();
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw new Error('Cannot start the reminder background process');
      if (store.running()) return store.lease().pid;
      await delay(50);
    }
    throw new Error('Reminder background process did not become ready');
  } finally { store.close(); }
}

export async function scheduleNotification(args, config, { dataDir = getDataDir(), start = ensureSchedulerRunning } = {}) {
  const store = new ReminderStore(dataDir);
  let row;
  try {
    row = store.add(args, config);
    try { await start(store.dataDir); }
    catch {
      const cancelled = store.cancel(row.id);
      if (!cancelled.ok) {
        return { ok: false, ...store.publicJob(store.get(row.id)), scheduler_running: store.running(),
          message: 'Scheduler startup could not be confirmed and this task is no longer pending. Inspect its status before trying again.' };
      }
      throw new Error('Cannot start the reminder background process; this reminder was cancelled');
    }
    return { ok: true, ...store.publicJob(store.get(row.id)),
      scheduler_running: true, delivery_confirmed: false,
      message: 'Reminder saved locally. Requires this computer to be running and online. It will not be sent more than 30 minutes late.' };
  } finally { store.close(); }
}

export async function resumePendingReminders(dataDir = getDataDir()) {
  const store = new ReminderStore(dataDir);
  let pending;
  try { pending = store.list({ limit: 1 }).length > 0; }
  finally { store.close(); }
  if (pending) await ensureSchedulerRunning(dataDir);
}

export function listReminders(args, dataDir = getDataDir()) {
  const store = new ReminderStore(dataDir);
  try { return { ok: true, scheduler_running: store.running(), tasks: store.list(args) }; }
  finally { store.close(); }
}

export function cancelReminder(id, dataDir = getDataDir()) {
  const store = new ReminderStore(dataDir);
  try { return store.cancel(id); }
  finally { store.close(); }
}
