import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { loadConfig } from './config.mjs';
import { createBarkTools, notificationSchema } from './bark.mjs';
import { result } from './result.mjs';
import { cancelReminder, listReminders, resumePendingReminders } from './scheduler.mjs';

export function createServer(config) {
  const tools = createBarkTools(config);
  const server = new McpServer({ name: 'bark-local', version: '1.1.1' }, {
    instructions: 'Send or schedule notifications ONLY when explicitly requested by the user. Never infer consent from task completion or failure. user_requested must be true. send_at omitted/null sends now; a future ISO timestamp with timezone schedules locally. Convert relative times using current time. Never silently roll past dates forward. TTL is history lifetime, not scheduling. No automatic send retries. Report scheduled vs accepted vs phone delivery separately. Resume only previously authorized reminders on startup. Requires the computer running and online; reminders over 30 minutes late expire.',
  });

  server.registerTool('send_notification', {
    title: 'Send a Bark notification',
    description: 'Send one user-requested Bark notification. send_at omitted/null sends immediately; a future ISO timestamp with timezone saves a reminder and returns immediately. Local reminders require the computer running and online, and expire after 30 minutes late. No default TTL, critical alert, repeated ringing or automatic retries. scheduled means saved, accepted means Bark accepted, neither confirms phone delivery.',
    inputSchema: notificationSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, args => tools.sendNotification(args));

  server.registerTool('check_service', {
    title: 'Check Bark service',
    description: 'Check the configured Bark health endpoint without sending a notification. This does not validate the device key or prove phone delivery.',
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, () => tools.checkService());

  server.registerTool('list_scheduled_notifications', {
    title: 'List Bark reminders',
    description: 'List reminders shared by local clients using this project. Default: pending/sending tasks; include_completed includes results, cancellations and expiry. Returns task IDs, UTC send times and messages, never device keys. Does not send notifications.',
    inputSchema: z.strictObject({
      include_completed: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => {
    try { return result(listReminders(args)); }
    catch { return result({ ok: false, error: 'reminder_store_unavailable' }, true); }
  });

  server.registerTool('cancel_scheduled_notification', {
    title: 'Cancel a Bark reminder',
    description: 'Cancel a pending reminder by task_id ONLY when requested by the user. Repeated cancellation is safe. Once a send has started, cancellation cannot recall the push. Does not send notifications.',
    inputSchema: z.strictObject({
      task_id: z.uuid().describe('Reminder task_id returned by send_notification or the list tool.'),
      user_requested: z.literal(true).describe('True only when the user requested cancellation.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => {
    try { const data = cancelReminder(args.task_id); return result(data, !data.ok); }
    catch { return result({ ok: false, error: 'reminder_store_unavailable' }, true); }
  });

  return server;
}

async function main() {
  const server = createServer(loadConfig());
  try { await resumePendingReminders(); }
  catch { process.stderr.write('Bark pending reminders could not resume; use the scheduler status command.\n'); }
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  // Keep stdout exclusively for MCP JSON-RPC, and never log configuration values.
  const knownConfigError = /^(Invalid Bark configuration|Cannot read Bark (config|env)|Bark server)/.test(error.message);
  process.stderr.write(`Bark MCP startup failed: ${knownConfigError ? error.message : 'initialization error'}\n`);
  process.exitCode = 1;
});
