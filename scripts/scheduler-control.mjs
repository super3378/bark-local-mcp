import { ensureSchedulerRunning } from '../src/scheduler.mjs';
import { ReminderStore } from '../src/store.mjs';

const command = process.argv[2] || 'status';
try {
  if (command === 'start') {
    console.log(JSON.stringify({ ok: true, pid: await ensureSchedulerRunning() }));
  } else {
    const store = new ReminderStore();
    try {
      const running = store.running();
      const lease = store.lease();
      if (command === 'stop' && running) process.kill(lease.pid, 'SIGTERM');
      else if (!['status', 'stop'].includes(command)) throw new Error('Unknown command');
      console.log(JSON.stringify({ ok: true, scheduler_running: command === 'stop' ? false : running,
        ...(running ? { pid: lease.pid } : {}), pending: store.list({ limit: 100 }).length }));
    } finally { store.close(); }
  }
} catch {
  console.error('Bark scheduler command failed.');
  process.exitCode = 1;
}
