import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig, validateConfig } from '../src/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(`${root}work`, { recursive: true });
const fakeKey = 'TESTKEY123456';
const decode = result => result.structuredContent ?? JSON.parse(result.content[0].text);

test('config supports root paths and rejects unsafe or invalid server addresses', () => {
  const base = { serverUrl: 'https://example.com/bark/', deviceKey: fakeKey };
  assert.equal(validateConfig(base).serverUrl, 'https://example.com/bark');
  assert.equal(validateConfig(base).timeoutMs, 10000);
  for (const serverUrl of ['http://example.com', 'https://user:password@example.com', 'https://example.com/?key=x']) {
    assert.throws(() => validateConfig({ ...base, serverUrl }));
  }
  assert.throws(() => validateConfig({ ...base, deviceKey: '' }));
  assert.throws(() => validateConfig({ ...base, timeoutMs: NaN }));
  const env = { BARK_CONFIG_FILE: new URL('../work/nonexistent.json', import.meta.url),
    BARK_SERVER_URL: base.serverUrl, BARK_DEVICE_KEY: fakeKey, BARK_DEFAULT_GROUP: 'Custom' };
  assert.equal(loadConfig(env).defaultGroup, 'Custom');
});

test('real stdio handshake and tool calls against an isolated HTTP mock', async t => {
  const requests = [];
  const mock = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    if (req.url === '/base/healthz') return res.end('ok');
    if (body?.title === 'timeout') {
      setTimeout(() => { if (!res.destroyed) res.end('{"code":200}'); }, 300);
      return;
    }
    if (body?.title === 'redirect') {
      res.writeHead(302, { location: '/must-not-follow' });
      return res.end();
    }
    if (body?.title === 'invalid-json') return res.end('<html>not json</html>');
    res.setHeader('content-type', 'application/json');
    if (body?.title === 'reject') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ code: 400, message: `invalid device ${fakeKey}` }));
    }
    res.end('{"code":200,"message":"success"}');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const client = new Client({ name: 'bark-tests', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--use-env-proxy', fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    cwd: `${root}work`,
    env: {
      ...process.env,
      BARK_CONFIG_FILE: fileURLToPath(new URL('../work/nonexistent.json', import.meta.url)),
      BARK_SERVER_URL: `http://127.0.0.1:${mock.address().port}/base`,
      BARK_DEVICE_KEY: fakeKey,
      BARK_DEFAULT_GROUP: 'Codex',
      BARK_TIMEOUT_MS: '100',
      BARK_DATA_DIR: mkdtempSync(`${root}work/mcp-test-`),
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    await client.connect(transport);
    await t.test('lists four tools without making any network request', async () => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(x => x.name).sort(), ['cancel_scheduled_notification', 'check_service', 'list_scheduled_notifications', 'send_notification']);
      const send = tools.find(x => x.name === 'send_notification');
      assert.ok(send.inputSchema.required.includes('user_requested'));
      assert.equal(send.annotations.idempotentHint, false);
      assert.equal(send.inputSchema.properties.ttl.default, undefined);
      assert.equal(requests.length, 0);
    });
    await t.test('health check never sends a notification', async () => {
      const result = await client.callTool({ name: 'check_service', arguments: {} });
      assert.equal(decode(result).status, 'healthy');
      assert.deepEqual(requests.map(x => x.path), ['/base/healthz']);
    });
    await t.test('missing or false explicit-request flag is rejected before HTTP', async () => {
      const count = requests.length;
      for (const args of [{ body: 'test' }, { body: 'test', user_requested: false }]) {
        const result = await client.callTool({ name: 'send_notification', arguments: args });
        assert.equal(result.isError, true);
      }
      assert.equal(requests.length, count);
    });
    await t.test('posts Unicode and special characters as JSON, without a default TTL', async () => {
      const body = '中文 & + ? # /\n第二行 🔔';
      const result = await client.callTool({ name: 'send_notification', arguments: { user_requested: true, title: '测试', body, send_at: null } });
      assert.equal(result.isError, undefined);
      assert.equal(decode(result).status, 'accepted');
      assert.equal(decode(result).delivery_confirmed, false);
      const last = requests.at(-1);
      assert.equal(last.method, 'POST');
      assert.equal(last.path, '/base/push');
      assert.equal(last.body.body, body);
      assert.equal(last.body.group, 'Codex');
      assert.equal(last.body.device_key, fakeKey);
      for (const field of ['ttl', 'sound', 'call', 'level', 'user_requested', 'send_at']) assert.equal(field in last.body, false);
      assert.equal(JSON.stringify(result).includes(fakeKey), false);
    });
    await t.test('maps optional official Bark parameters and preserves numeric zero', async () => {
      const result = await client.callTool({ name: 'send_notification', arguments: {
        user_requested: true, markdown: '**完成**', group: '自定义', url: 'shortcuts://run-shortcut?name=test',
        level: 'critical', volume: 0, call: false, isArchive: true, ttl: 60, badge: 0, id: 'progress-1',
      } });
      assert.equal(result.isError, undefined);
      const body = requests.at(-1).body;
      assert.equal(body.isArchive, '1');
      assert.equal(body.call, '0');
      assert.equal(body.ttl, 60);
      assert.equal(body.volume, 0);
      assert.equal(body.badge, 0);
      assert.equal(body.id, 'progress-1');
      assert.ok(body.url.startsWith('shortcuts:'));
    });
    await t.test('invalid parameters and unsupported overrides cannot trigger a push', async () => {
      const count = requests.length;
      for (const args of [{}, { body: ' ' }, { body: 'a', ttl: 0 }, { body: 'a', volume: 2 },
        { body: 'a', ttl: 60, isArchive: false }, { body: 'a', device_key: 'OTHER' }, { body: 'a', delete: '1' },
        { body: 'a', send_at: 'none' }, { body: 'a', send_at: '2026-11-04T15:30:00' },
        { body: 'a', send_at: '2026-02-30T15:30:00+08:00' }, { body: 'a', send_at: '2020-01-01T00:00:00Z' }]) {
        const result = await client.callTool({ name: 'send_notification', arguments: { user_requested: true, ...args } });
        assert.equal(result.isError, true);
      }
      assert.equal(requests.length, count);
    });
    await t.test('upstream failures redact the device key and are never retried', async () => {
      const count = requests.length;
      const result = await client.callTool({ name: 'send_notification', arguments: { user_requested: true, title: 'reject' } });
      assert.equal(result.isError, true);
      assert.equal(decode(result).status, 'rejected');
      assert.equal(JSON.stringify(result).includes(fakeKey), false);
      assert.equal(requests.length, count + 1);
    });
    await t.test('invalid response is reported as unknown rather than delivered', async () => {
      const result = await client.callTool({ name: 'send_notification', arguments: { user_requested: true, title: 'invalid-json' } });
      assert.equal(result.isError, true);
      assert.equal(decode(result).status, 'unknown');
    });
    await t.test('redirects are not followed and the key is not forwarded', async () => {
      const count = requests.length;
      const result = await client.callTool({ name: 'send_notification', arguments: { user_requested: true, title: 'redirect' } });
      assert.equal(result.isError, true);
      assert.equal(requests.length, count + 1);
      assert.equal(requests.some(x => x.path === '/must-not-follow'), false);
    });
    await t.test('timeouts report unknown outcome without an automatic retry', async () => {
      const count = requests.length;
      const result = await client.callTool({ name: 'send_notification', arguments: { user_requested: true, title: 'timeout' } });
      assert.equal(result.isError, true);
      assert.equal(decode(result).error, 'request_timeout');
      assert.equal(decode(result).status, 'unknown');
      assert.equal(requests.length, count + 1);
    });
    assert.equal(stderr.includes(fakeKey), false);
  } finally {
    await client.close();
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
  }
});
