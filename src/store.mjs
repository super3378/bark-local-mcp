import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadEnvironment } from './config.mjs';

export const defaultDataDir = fileURLToPath(new URL('../data/', import.meta.url));
export const GRACE_MS = 30 * 60 * 1000;
export const LEASE_MS = 30000;

export function getDataDir(env = process.env) {
  return resolve(loadEnvironment(env).BARK_DATA_DIR || defaultDataDir);
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export class ReminderStore {
  constructor(dataDir = getDataDir()) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(this.dataDir, 'reminders.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, grace_ms INTEGER NOT NULL, status TEXT NOT NULL,
        args_json TEXT NOT NULL, connection_json TEXT NOT NULL, claimed_by TEXT, result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, due_at);
      CREATE TABLE IF NOT EXISTS scheduler_lease (
        id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, pid INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );`);
  }

  close() { this.db.close(); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  add(args, connection, now = Date.now()) {
    const id = randomUUID();
    const dueAt = Date.parse(args.send_at);
    if (!Number.isFinite(dueAt) || dueAt <= now) throw new Error('send_at must be in the future');
    const { send_at, ...notification } = args;
    this.db.prepare(`INSERT INTO reminders
      (id,due_at,created_at,updated_at,grace_ms,status,args_json,connection_json)
      VALUES (?,?,?,?,?,'pending',?,?)`).run(id, dueAt, now, now, GRACE_MS,
      JSON.stringify(notification), JSON.stringify(connection));
    return this.get(id);
  }

  get(id) { return this.db.prepare('SELECT * FROM reminders WHERE id=?').get(id); }

  publicJob(row) {
    const args = JSON.parse(row.args_json);
    return {
      task_id: row.id, status: row.status,
      send_at: new Date(row.due_at).toISOString(),
      created_at: new Date(row.created_at).toISOString(),
      late_delivery_window_seconds: row.grace_ms / 1000,
      notification: Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'user_requested')),
      ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}),
    };
  }

  expire(now = Date.now()) {
    this.db.prepare(`UPDATE reminders SET status='expired', updated_at=?
      WHERE status='pending' AND due_at+grace_ms<?`).run(now, now);
  }

  list({ include_completed = false, limit = 50, offset = 0 } = {}) {
    this.expire();
    const where = include_completed ? '' : "WHERE status IN ('pending','sending')";
    const direction = include_completed ? 'DESC' : 'ASC';
    return this.db.prepare(`SELECT * FROM reminders ${where} ORDER BY due_at ${direction}, id LIMIT ? OFFSET ?`)
      .all(limit, offset).map(row => this.publicJob(row));
  }

  cancel(id, now = Date.now()) {
    this.expire(now);
    this.db.prepare("UPDATE reminders SET status='cancelled', updated_at=? WHERE id=? AND status='pending'").run(now, id);
    const row = this.get(id);
    if (!row) return { ok: false, error: 'task_not_found' };
    if (row.status !== 'cancelled') return { ok: false, error: 'task_already_started_or_finished', task_id: id, status: row.status };
    return { ok: true, task_id: id, status: 'cancelled' };
  }

  lease() { return this.db.prepare('SELECT * FROM scheduler_lease WHERE id=1').get(); }

  acquire(owner, pid, now = Date.now()) {
    return this.transaction(() => {
      const lease = this.lease();
      if (lease && lease.expires_at > now && processAlive(lease.pid)) return false;
      this.db.prepare(`INSERT INTO scheduler_lease VALUES(1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,pid=excluded.pid,expires_at=excluded.expires_at`)
        .run(owner, pid, now + LEASE_MS);
      // A previous sender may have reached Bark before it crashed. Never resend it automatically.
      this.db.prepare(`UPDATE reminders SET status='unknown',updated_at=?,
        result_json=? WHERE status='sending'`).run(now,
        JSON.stringify({ ok: false, status: 'unknown', error: 'sender_interrupted', delivery_confirmed: false }));
      return true;
    });
  }

  heartbeat(owner, now = Date.now()) {
    return this.db.prepare('UPDATE scheduler_lease SET expires_at=? WHERE id=1 AND owner=?')
      .run(now + LEASE_MS, owner).changes === 1;
  }

  release(owner) { this.db.prepare('DELETE FROM scheduler_lease WHERE owner=?').run(owner); }

  running() {
    const lease = this.lease();
    return Boolean(lease && lease.expires_at > Date.now() && processAlive(lease.pid));
  }

  claim(owner, now = Date.now()) {
    return this.transaction(() => {
      const lease = this.lease();
      if (!lease || lease.owner !== owner || lease.expires_at <= now) return undefined;
      this.expire(now);
      const row = this.db.prepare("SELECT * FROM reminders WHERE status='pending' AND due_at<=? ORDER BY due_at,id LIMIT 1").get(now);
      if (!row) return undefined;
      this.db.prepare("UPDATE reminders SET status='sending',claimed_by=?,updated_at=? WHERE id=? AND status='pending'")
        .run(owner, now, row.id);
      return row;
    });
  }

  finish(id, owner, outcome, now = Date.now()) {
    this.db.prepare(`UPDATE reminders SET status=?,result_json=?,updated_at=?
      WHERE id=? AND status='sending' AND claimed_by=?`)
      .run(outcome.status, JSON.stringify(outcome), now, id, owner);
  }
}
