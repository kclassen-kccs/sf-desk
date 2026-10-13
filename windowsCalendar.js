// Reads classic Outlook's calendars on Windows for Time Entry, through Outlook's COM API. The work is
// done by a PowerShell script (windows/outlook-calendar.ps1), since Windows PowerShell is on every
// Windows PC and can talk COM without any npm package. Events come back in the same shape as the
// Mac's EventKit helper (see macCalendar.js). Only available on Windows.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

class CalendarError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function windowsCalendar(rootDir) {
  const script = process.env.SF_DESK_CALENDAR_SCRIPT || path.join(rootDir, 'windows', 'outlook-calendar.ps1');

  // Windows PowerShell 5.1 in a single-threaded apartment, which Outlook's COM objects expect.
  // Outlook can take a while to answer when it has just started or is syncing.
  function helper(args) {
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
        { timeout: 180_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          let data;
          try { data = JSON.parse(String(stdout) || 'null'); } catch { data = undefined; }
          if (data?.error) return reject(new CalendarError(data.message, data.error === 'nooutlook' ? 404 : 502));
          if (err || data === undefined) {
            const why = String(stderr || '').trim() || err?.message || 'no output';
            return reject(new CalendarError(/execution of scripts is disabled|ExecutionPolicy|ConstrainedLanguage/i.test(why)
              ? 'Your PC\'s PowerShell policy stops SF Desk from reading Outlook. Ask IT to allow it, or pick Salesforce events.'
              : `Outlook calendar helper failed: ${why}`));
          }
          resolve(data);
        });
    });
  }

  // [{ id, title, account, type }], Exchange mailboxes first.
  async function calendars() {
    const list = await helper(['calendars']);
    const rank = (c) => (c.type === 'exchange' ? 0 : c.type === 'subscribed' ? 2 : 1);
    return list.sort((a, b) => rank(a) - rank(b) || a.account.localeCompare(b.account) || a.title.localeCompare(b.title));
  }

  // Events between two instants in the given calendars, each with a stable id for its occurrence.
  async function events(fromIso, toIso, ids) {
    const data = await helper(['events', fromIso, toIso, ids.join(',')]);
    // With no events, the helper says what Outlook shows instead (data.diag), for the page to show.
    const list = (Array.isArray(data) ? data : data?.events || []).filter((e) => !e.canceled).map((e) => ({
      ...e,
      id: 'win_' + crypto.createHash('sha1').update(`${e.uid}|${e.start}`).digest('hex').slice(0, 24),
    }));
    if (data?.diag) list.note = `Outlook: ${data.diag}`;
    return list;
  }

  return { calendars, events };
}
