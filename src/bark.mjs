import { z } from 'zod';
import { result } from './result.mjs';

const nonblank = z.string().refine(value => value.trim().length > 0, 'Must not be blank');
const link = z.string().url().describe('A URL or app URL scheme supported by iOS, such as https:// or shortcuts://.');

export const notificationSchema = z.strictObject({
  user_requested: z.literal(true).describe('Set true ONLY when the user explicitly requested this notification. Never infer consent from task completion or failure.'),
  send_at: z.iso.datetime({ offset: true }).nullable().optional()
    .describe('Omit or use null to send now. To schedule, use a future ISO 8601 timestamp with timezone, e.g. 2026-11-04T15:30:00+08:00. Convert relative requests such as in 30 minutes into an explicit timestamp. Never guess the date for an ambiguous or past time.'),
  title: nonblank.optional().describe('Notification title.'),
  subtitle: nonblank.optional().describe('Optional subtitle.'),
  body: nonblank.optional().describe('Plain-text content; supports Unicode and newlines.'),
  markdown: nonblank.optional().describe('Markdown content. When provided, Bark ignores body.'),
  group: z.string().max(200).optional().describe('Notification group. Omit to use the configured group (Codex by default).'),
  url: link.optional().describe('URL to open when the user taps the notification. Supports app URL schemes.'),
  icon: z.httpUrl().optional().describe('Custom notification icon URL; requires iOS 15+.'),
  image: z.httpUrl().optional().describe('Image URL shown when the notification is expanded.'),
  sound: nonblank.optional().describe('Bark sound name, for example minuet. Omit to use the deployed server default.'),
  level: z.enum(['active', 'passive', 'timeSensitive', 'critical']).optional()
    .describe('Notification level. Use critical only if the user specifically requests a critical alert; requires iOS permission.'),
  volume: z.number().int().min(0).max(10).optional().describe('Critical alert volume (0-10); only valid with level=critical.'),
  call: z.boolean().optional().describe('True repeats the ringtone for 30 seconds. Set only if the user specifically requests repeated ringing.'),
  badge: z.number().int().min(0).optional().describe('Set the app badge. Zero also clears Bark notifications from Notification Center.'),
  copy: z.string().optional().describe('Text copied when the user chooses the notification copy action.'),
  action: z.enum(['alert', 'none']).optional().describe('Tap action; url takes precedence.'),
  isArchive: z.boolean().optional().describe('Save to Bark history. Omit to follow the app preference.'),
  ttl: z.number().int().positive().optional().describe('Lifetime of a saved notification in seconds. No default. Not a send delay.'),
  id: nonblank.optional().describe('String notification identifier; reuse to update an existing notification.'),
}).superRefine((value, ctx) => {
  if (![value.title, value.subtitle, value.body, value.markdown].some(Boolean)) {
    ctx.addIssue({ code: 'custom', path: ['body'], message: 'Provide title, subtitle, body or markdown' });
  }
  if (value.volume !== undefined && value.level !== 'critical') {
    ctx.addIssue({ code: 'custom', path: ['volume'], message: 'volume requires level=critical' });
  }
  if (value.ttl !== undefined && value.isArchive === false) {
    ctx.addIssue({ code: 'custom', path: ['ttl'], message: 'ttl only applies to saved history; isArchive cannot be false' });
  }
});

function safeReason(value, config) {
  if (typeof value !== 'string') return undefined;
  return value.replaceAll(config.deviceKey, '[REDACTED]').slice(0, 500);
}

export function createBarkTools(config, fetchImpl = fetch, { schedule } = {}) {
  async function request(path, options = {}) {
    return fetchImpl(`${config.serverUrl}${path}`, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  }

  function networkFailure(error, sending) {
    const timedOut = ['TimeoutError', 'AbortError'].includes(error.name);
    return result({
      ok: false,
      status: sending ? 'unknown' : 'unreachable',
      error: timedOut ? 'request_timeout' : 'network_error',
      message: sending
        ? 'Push outcome is unknown. The request was not retried; check the phone before sending again.'
        : 'Health check failed. No notification was sent.',
    }, true);
  }

  return {
    async sendNotification(raw) {
      const parsed = notificationSchema.safeParse(raw);
      if (!parsed.success) {
        return result({ ok: false, status: 'not_sent', error: 'invalid_arguments',
          issues: parsed.error.issues.map(({ path, message }) => ({ field: path.join('.'), message })) }, true);
      }
      const { user_requested, send_at, ...args } = parsed.data;
      if (send_at !== undefined && send_at !== null) {
        if (Date.parse(send_at) <= Date.now()) {
          return result({ ok: false, status: 'not_sent', error: 'send_at_in_past',
            message: 'send_at must be in the future. No notification was sent or scheduled.' }, true);
        }
        try {
          const scheduleFn = schedule ?? (await import('./scheduler.mjs')).scheduleNotification;
          const scheduled = await scheduleFn(parsed.data, config);
          return result(scheduled, !scheduled.ok);
        } catch {
          return result({ ok: false, status: 'not_scheduled', error: 'scheduling_failed',
            message: 'Could not save and start the local reminder. No immediate push was sent. Check the reminder list before trying again.' }, true);
        }
      }
      const payload = { ...args, device_key: config.deviceKey, group: args.group ?? config.defaultGroup };
      // Bark expects string flags rather than JSON booleans for these options.
      if (args.call !== undefined) payload.call = args.call ? '1' : '0';
      if (args.isArchive !== undefined) payload.isArchive = args.isArchive ? '1' : '0';
      let response;
      let data;
      try {
        response = await request('/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
          body: JSON.stringify(payload),
        });
        data = await response.json();
      } catch (error) {
        if (response && error instanceof SyntaxError) {
          return result({ ok: false, status: 'unknown', error: 'invalid_response', http_status: response.status,
            message: 'Bark returned a non-JSON response. No automatic retry; delivery is not confirmed.' }, true);
        }
        return networkFailure(error, true);
      }
      if (!response.ok || data?.code !== 200) {
        return result({ ok: false, status: 'rejected', error: 'bark_rejected', http_status: response.status,
          bark_code: typeof data?.code === 'number' ? data.code : undefined,
          reason: safeReason(data?.message, config) }, true);
      }
      return result({ ok: true, status: 'accepted', delivery_confirmed: false,
        message: 'Bark accepted the push request. This does not confirm that the phone displayed it.' });
    },

    async checkService() {
      try {
        const response = await request('/healthz', { method: 'GET', headers: { accept: 'text/plain' } });
        const text = await response.text();
        if (!response.ok || text.trim() !== 'ok') {
          return result({ ok: false, status: 'unhealthy', http_status: response.status,
            message: 'Health endpoint did not return ok. No notification was sent.' }, true);
        }
        return result({ ok: true, status: 'healthy',
          message: 'Bark health endpoint is reachable. Device key and phone delivery were not tested. No notification was sent.' });
      } catch (error) {
        return networkFailure(error, false);
      }
    },
  };
}
