// Reads the Mac's own calendars (System Settings > Internet Accounts: Exchange, iCloud, Google...)
// for My Calendar. Uses a small EventKit helper (mac/calendar.swift), compiled with the Xcode
// Command Line Tools on first use into data/bin; without them, falls back to asking Calendar.app
// through JavaScript for Automation, which is slower, can't name accounts and skips repeats of
// repeating events. Only available on macOS.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const isMac = process.platform === 'darwin';

const run = (cmd, args, timeout = 120_000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && !stdout) return reject(Object.assign(err, { stderr: String(stderr || '') }));
    resolve(String(stdout));
  });
});

class CalendarError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export function macCalendar(rootDir, dataDir) {
  const src = path.join(rootDir, 'mac', 'calendar.swift');
  const plist = path.join(rootDir, 'mac', 'Info.plist');
  const bin = path.join(dataDir, 'bin', 'sfdesk-calendar');
  let ready = null; // Promise of 'eventkit' | 'jxa'

  async function build() {
    try {
      const stale = !fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs;
      if (stale) {
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        // The embedded Info.plist carries the text macOS shows when asking for calendar access.
        await run('xcrun', ['swiftc', '-O', '-swift-version', '5', src, '-o', bin,
          '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist], 300_000);
      }
      return 'eventkit';
    } catch (err) {
      console.warn(`Couldn't build the calendar helper (${(err.stderr || err.message).trim().split('\n')[0]}); ` +
        'using Calendar.app instead. Install the Command Line Tools (xcode-select --install) for faster, fuller results.');
      return 'jxa';
    }
  }

  const how = () => (ready ||= build());

  async function helper(args) {
    const text = await run(bin, args).catch((err) => {
      throw new CalendarError(`Calendar helper failed: ${(err.stderr || err.message).trim()}`);
    });
    const data = JSON.parse(text || 'null');
    if (data?.error) throw new CalendarError(data.message, data.error === 'denied' ? 403 : 502);
    return data;
  }

  async function jxa(fn, ...args) {
    const script = `function run(argv) { return JSON.stringify((${fn})(...argv.map((a) => JSON.parse(a)))); }`;
    const text = await run('osascript', ['-l', 'JavaScript', '-e', script, ...args.map((a) => JSON.stringify(a))], 180_000)
      .catch((err) => {
        const msg = (err.stderr || err.message).trim();
        throw new CalendarError(/-1743|not allowed|Not authorized/i.test(msg)
          ? 'SF Desk isn\'t allowed to control Calendar. In System Settings > Privacy & Security > Automation, allow it, then reload.'
          : `Calendar.app failed: ${msg}`, /-1743|not allowed|Not authorized/i.test(msg) ? 403 : 502);
      });
    return JSON.parse(text);
  }

  // [{ id, title, account, type }], Exchange accounts first.
  async function calendars() {
    const list = (await how()) === 'eventkit'
      ? await helper(['calendars'])
      : (await jxa(() => Application('Calendar').calendars.name())).map((name) => ({ id: 'name:' + name, title: name, account: 'Calendar app', type: 'other' }));
    const rank = (c) => (c.type === 'exchange' ? 0 : c.type === 'birthdays' || c.type === 'subscribed' ? 2 : 1);
    return list.sort((a, b) => rank(a) - rank(b) || a.account.localeCompare(b.account) || a.title.localeCompare(b.title));
  }

  // Events between two instants in the given calendars, each with a stable id for its occurrence.
  async function events(fromIso, toIso, ids) {
    let list;
    if ((await how()) === 'eventkit') {
      list = await helper(['events', fromIso, toIso, ids.join(',')]);
    } else {
      list = (await jxa((names, from, to) => {
        const Cal = Application('Calendar'), out = [];
        const pad = (n) => String(n).padStart(2, '0');
        for (const name of names) {
          const evs = Cal.calendars.byName(name).events.whose({ _and: [{ startDate: { _lessThan: new Date(to) } }, { endDate: { _greaterThan: new Date(from) } }] });
          const [uid, title, start, end, allDay, location, notes] =
            [evs.uid(), evs.summary(), evs.startDate(), evs.endDate(), evs.alldayEvent(), evs.location(), evs.description()];
          uid.forEach((u, i) => out.push({ uid: u, title: title[i] || '', start: start[i].toISOString(), end: end[i].toISOString(),
            date: `${start[i].getFullYear()}-${pad(start[i].getMonth() + 1)}-${pad(start[i].getDate())}`, allDay: allDay[i],
            location: location[i] || '', notes: notes[i] || '', calendar: name, calendarId: 'name:' + name, organizer: '', attendees: [] }));
        }
        return out;
      }, ids.filter((id) => id.startsWith('name:')).map((id) => id.slice(5)), fromIso, toIso));
    }
    return list.filter((e) => !e.canceled).map((e) => ({
      ...e,
      id: 'mac_' + crypto.createHash('sha1').update(`${e.uid}|${e.start}`).digest('hex').slice(0, 24),
    }));
  }

  return { calendars, events };
}
