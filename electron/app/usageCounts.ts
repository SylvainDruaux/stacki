// Stacki reports only one daily count after a project opens. No project data,
// installation identifier, or interaction history leaves the app.

import { assert } from '../../shared/core/assert';

export const USAGE_NOTICE_VERSION = 1;
export const USAGE_COUNTS_URL = 'https://stacki-usage-counts.timothymricks.workers.dev/daily';
const REQUEST_TIMEOUT_MS = 3_000;

export function usageDay(date: Date): string {
  const day = date.toISOString().slice(0, 10);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(day), 'Usage day must be a UTC date');
  return day;
}

export function shouldCountUsage(
  input: {
    readonly packaged: boolean;
    readonly enabled: boolean;
    readonly noticeVersion: number;
    readonly lastAttemptDay: string | undefined;
  },
  day: string,
): boolean {
  if (!input.packaged || !input.enabled) {
    return false;
  }
  if (input.noticeVersion < USAGE_NOTICE_VERSION) {
    return false;
  }
  return input.lastAttemptDay !== day;
}

export async function sendUsageCount(
  options: { readonly signal: AbortSignal },
  request: (url: string, options: RequestInit) => Promise<Response>,
): Promise<boolean> {
  try {
    const response = await request(USAGE_COUNTS_URL, {
      method: 'POST',
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    return response.status === 204;
  } catch {
    // Offline use is normal; counting must never interrupt editing.
    return false;
  }
}
