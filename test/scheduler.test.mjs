import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ReminderStore, GRACE_MS, processAlive } from '../src/store.mjs';
import { ensureSchedulerRunning, scheduleNotification } from '../src/scheduler.mjs';

const work = fileURLToPath(new URL('../work/', import.meta.url));
mkdirSync(work, { recursive: true });
const serverFile = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const connection = { serverUrl: 'https://example.invalid', deviceKey: 'FAKEKEYONLY', defaultGroup: 'Codex', timeoutMs: 1000 };
const decode = response => response.structuredContent ?? JSON.parse(response.content[0].text);
const later = ms => new Date(Date.now() + ms).toISOString();

async function until(check, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error('Timed out waiting for test condition');
}

test('persistent store handles competing claims, cancellation, expiry and interrupted sends', () => {
  const dir = mkdtempSync(`${work}store-test-`);
  let store = new ReminderStore(dir);
  const now = Date.now();
  const args = { user_requested: true, body: '测试持久化', send_at: new Date(now + 1000).toISOString() };
  const first = store.add(args, connection, now);
  const cancelled = store.add(args, connection, now);
  assert.equal(store.cancel(cancelled.id, now).status, 'cancelled');
  assert.equal(store.cancel(cancelled.id, now).ok, true);
  assert.equal(store.cancel('missing', now).error, 'task_not_found');
  assert.equal(store.acquire('one', process.pid, now), true);
  assert.equal(store.acquire('two', process.pid, now), false);
  assert.equal(store.claim('two', now + 1001), undefined);
  assert.equal(store.claim('one', now + 1001).id, first.id);
  assert.equal(store.claim('one', now + 1001), undefined);
  assert.equal(store.cancel(first.id, now + 1001).ok, false);
  store.close();
  store = new ReminderStore(dir);
  try {
    assert.equal(store.get(first.id).status, 'sending');
    assert.equal(store.acquire('new', process.pid, now + 40000), true);
    assert.equal(store.get(first.id).status, 'unknown');
    const expired = store.add(args, connection, now);
    store.expire(now + 1001 + GRACE_MS);
    assert.equal(store.get(expired.id).status, 'expired');
    const output = JSON.stringify(store.list({ include_completed: true }));
    assert.equal(output.includes(connection.deviceKey), false);
    assert.equal(output.includes('connection_json'), false);
  } finally { store.close(); }
});

test('a startup failure cancels the saved task and never falls back to an immediate send', async () => {
  const dir = mkdtempSync(`${work}startup-failure-`);
  await assert.rejects(scheduleNotification({ user_requested: true, body: 'never send', send_at: later(60000) }, connection,
    { dataDir: dir, start: async () => { throw new Error('test failure'); } }));
  const store = new ReminderStore(dir);
  try { assert.equal(store.list({ include_completed: true })[0].status, 'cancelled'); }
  finally { store.close(); }
});

test('multiple MCP clients share one detached scheduler, recover after restart, and never resend unknown outcomes', { timeout: 45000 }, async t => {
  const dir = mkdtempSync(`${work}scheduler-test-`);
  const requests = [];
  const mock = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ time: Date.now(), body });
    if (body.title === 'unknown') { res.destroy(); return; }
    res.setHeader('content-type', 'application/json');
    res.end('{"code":200,"message":"success"}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const store = new ReminderStore(dir);
  const clients = [];
  const env = {
    ...process.env, BARK_DATA_DIR: dir,
    BARK_SERVER_URL: `http://127.0.0.1:${mock.address().port}`,
    BARK_DEVICE_KEY: connection.deviceKey, BARK_DEFAULT_GROUP: 'Shared', BARK_TIMEOUT_MS: '500',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  };
  async function connect() {
    const client = new Client({ name: 'reminder-integration', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--use-env-proxy', serverFile], env, stderr: 'pipe' }));
    clients.push(client);
    return client;
  }
  const send = (client, body, send_at) => client.callTool({ name: 'send_notification',
    arguments: { user_requested: true, body, send_at } });
  async function stop() {
    const lease = store.lease();
    if (lease && processAlive(lease.pid)) {
      process.kill(lease.pid, 'SIGTERM');
      await until(() => !processAlive(lease.pid));
    }
  }
  try {
    const [first, second] = await Promise.all([connect(), connect()]);
    let job;
    let peer;
    await t.test('concurrent clients register future tasks without sending early and expose all management tools', async () => {
      const sendAt = later(4000);
      const replies = await Promise.all([send(first, 'one', sendAt), send(second, 'two', sendAt)]);
      [job, peer] = replies.map(decode);
      assert.equal(job.status, 'pending');
      assert.equal(peer.status, 'pending');
      assert.notEqual(job.task_id, peer.task_id);
      assert.equal(requests.length, 0);
      const list = decode(await second.callTool({ name: 'list_scheduled_notifications', arguments: {} }));
      assert.equal(list.tasks.length, 2);
      assert.equal(JSON.stringify(list).includes(connection.deviceKey), false);
      const pids = await Promise.all([ensureSchedulerRunning(dir), ensureSchedulerRunning(dir)]);
      assert.equal(pids[0], pids[1]);
      assert.equal(store.running(), true);
    });
    await t.test('cancellation from the other client prevents the scheduled push', async () => {
      const result = decode(await second.callTool({ name: 'cancel_scheduled_notification',
        arguments: { task_id: peer.task_id, user_requested: true } }));
      assert.equal(result.status, 'cancelled');
    });
    await t.test('a scheduled send runs after all MCP clients disconnect, only once and not before its due time', async () => {
      await Promise.all(clients.splice(0).map(client => client.close()));
      assert.equal(store.running(), true);
      await until(() => store.get(job.task_id).status === 'accepted');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].body.body, 'one');
      assert.ok(requests[0].time >= Date.parse(job.send_at));
      assert.equal('send_at' in requests[0].body, false);
      assert.equal(requests[0].body.group, 'Shared');
      await delay(1200);
      assert.equal(requests.length, 1);
    });
    await t.test('pending tasks survive a killed scheduler and resume when a new MCP client connects', async () => {
      await stop();
      const saved = store.add({ user_requested: true, body: 'after restart', send_at: later(2500) },
        { ...connection, serverUrl: env.BARK_SERVER_URL });
      await connect();
      assert.equal(store.running(), true);
      await until(() => store.get(saved.id).status === 'accepted');
      assert.equal(requests.filter(x => x.body.body === 'after restart').length, 1);
    });
    await t.test('an uncertain network result is recorded and not retried across a scheduler restart', async () => {
      const client = clients.at(-1);
      const result = decode(await client.callTool({ name: 'send_notification', arguments: {
        user_requested: true, title: 'unknown', body: 'no retry', send_at: later(1500),
      } }));
      await until(() => store.get(result.task_id).status === 'unknown');
      await stop();
      await ensureSchedulerRunning(dir);
      await delay(1500);
      assert.equal(requests.filter(x => x.body.title === 'unknown').length, 1);
      const all = decode(await client.callTool({ name: 'list_scheduled_notifications', arguments: { include_completed: true } }));
      assert.equal(all.tasks.find(x => x.task_id === result.task_id).status, 'unknown');
    });
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await stop();
    store.close();
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
  }
});
