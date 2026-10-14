// Reads your Microsoft 365 calendars through Microsoft Graph for Time Entry. Unlike Outlook's COM API it
// works with the new Outlook (and without Outlook at all). Sign-in uses the device code flow with
// Microsoft's own "Microsoft Graph Command Line Tools" public client, so no app has to be registered:
// SF Desk shows a code, you enter it at microsoft.com/devicelogin, and it keeps the refresh token in
// the data folder (graph-token.json). Your organization may require an admin to approve that client
// for Calendars.Read; Microsoft's error then says so and the page shows it.
// Events come back in the same shape as the Mac's and Outlook's readers (see macCalendar.js).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CLIENT_ID = process.env.SF_DESK_GRAPH_CLIENT_ID || '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const TENANT = process.env.SF_DESK_GRAPH_TENANT || 'organizations';
const LOGIN = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'offline_access User.Read Calendars.Read';

class CalendarError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// Microsoft's errors, in words. AADSTS65001/90094/90099 and friends mean the tenant wants an admin to
// approve the client first.
function explain(data, fallback) {
  const desc = String(data?.error_description || data?.error?.message || fallback || '').split('\r\n')[0];
  if (/AADSTS(65001|90094|90099|900941|50105|53003)/.test(desc) || /admin(istrator)? (approval|consent)/i.test(desc)) {
    return 'Your organization needs an administrator to approve "Microsoft Graph Command Line Tools" reading your ' +
      `calendar (Calendars.Read) before SF Desk can use Microsoft 365. Ask IT, or use Outlook (classic) or Salesforce events. (${desc})`;
  }
  return desc || 'Microsoft 365 sign-in failed.';
}

async function form(url, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export function graphCalendar(dataDir) {
  const file = path.join(dataDir, 'graph-token.json');
  let saved = null; // { refresh_token, account }
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not signed in */ }
  let access = null; // { token, expires }
  let pending = null; // the device code sign-in in progress
  let lastError = '';
  const names = new Map(); // calendar id -> name, from calendars()

  const save = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      if (saved) fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
      else fs.rmSync(file, { force: true });
    } catch (err) { console.warn(`Couldn't save the Microsoft 365 sign-in: ${err.message}`); }
  };

  async function useTokens(data) {
    access = { token: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 };
    saved = { ...saved, refresh_token: data.refresh_token || saved?.refresh_token };
    if (!saved.account) {
      const me = await graph('/me?$select=displayName,mail,userPrincipalName');
      saved.account = me.mail || me.userPrincipalName || me.displayName || '';
    }
    save();
  }

  async function token() {
    if (access && access.expires > Date.now()) return access.token;
    if (!saved?.refresh_token) throw new CalendarError('Sign in to Microsoft 365 first.', 400);
    const { ok, data } = await form(`${LOGIN}/token`, { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: saved.refresh_token, scope: SCOPE });
    if (!ok) {
      // A refused refresh (expired, revoked, password changed) needs a new sign-in; a network error doesn't.
      if (data?.error) { saved = null; access = null; save(); }
      throw new CalendarError(`Microsoft 365 sign-in needs renewing: ${explain(data, 'no answer')}`, 400);
    }
    await useTokens(data);
    return access.token;
  }

  async function graph(pathAndQuery, headers = {}) {
    const url = pathAndQuery.startsWith('https://') ? pathAndQuery : GRAPH + pathAndQuery;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}`, ...headers } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new CalendarError(`Microsoft 365: ${explain(data, r.statusText)}`, r.status === 403 ? 403 : 502);
    return data;
  }

  // Start a device code sign-in; the code and link are for the page to show. Polls in the background.
  async function startSignIn() {
    if (pending && pending.expires > Date.now()) return pending.info;
    lastError = '';
    const { ok, data } = await form(`${LOGIN}/devicecode`, { client_id: CLIENT_ID, scope: SCOPE });
    if (!ok) throw new CalendarError(explain(data, 'Microsoft didn\'t start the sign-in.'), 400);
    const info = { userCode: data.user_code, verificationUri: data.verification_uri, message: data.message, expiresIn: data.expires_in };
    const me = pending = { info, expires: Date.now() + data.expires_in * 1000 };
    (async () => {
      let wait = (Number(data.interval) || 5) * 1000;
      while (pending === me && Date.now() < me.expires) {
        await new Promise((r) => setTimeout(r, wait));
        if (pending !== me) return;
        const res = await form(`${LOGIN}/token`, { client_id: CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: data.device_code })
          .catch((err) => ({ ok: false, data: { error: 'network', error_description: err.message } }));
        if (res.ok) {
          saved = null;
          try { await useTokens(res.data); } catch (err) { lastError = err.message; }
          pending = null;
          return;
        }
        const code = res.data?.error;
        if (code === 'authorization_pending' || code === 'network') continue;
        if (code === 'slow_down') { wait += 5000; continue; }
        lastError = code === 'expired_token' ? 'The sign-in code expired. Try again.'
          : code === 'authorization_declined' ? 'The sign-in was cancelled.' : explain(res.data);
        pending = null;
        return;
      }
      if (pending === me) { pending = null; lastError = 'The sign-in code expired. Try again.'; }
    })();
    return info;
  }

  function status() {
    return { signedIn: !!saved?.refresh_token, account: saved?.account || '', pending: pending ? pending.info : null, error: lastError };
  }

  function signOut() {
    saved = null; access = null; pending = null; lastError = '';
    save();
  }

  // [{ id, title, account, type }]: ids are "graph:" + Graph's calendar id.
  async function calendars() {
    const data = await graph('/me/calendars?$select=id,name,owner,isDefaultCalendar&$top=100');
    for (const c of data.value || []) names.set('graph:' + c.id, c.name);
    return (data.value || []).map((c) => ({
      id: 'graph:' + c.id, title: c.name, account: `${c.owner?.address || saved?.account || 'Microsoft 365'} (Microsoft 365)`,
      type: 'exchange', isDefault: !!c.isDefaultCalendar, source: 'graph',
    })).sort((a, b) => b.isDefault - a.isDefault || a.title.localeCompare(b.title));
  }

  const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Events between two instants in the given calendars, each with a stable id for its occurrence.
  async function events(fromIso, toIso, ids) {
    const me = String(saved?.account || '').toLowerCase();
    const select = 'id,iCalUId,subject,start,end,isAllDay,location,body,organizer,attendees,isCancelled,showAs';
    const out = [];
    for (const id of ids) {
      const calId = id.replace(/^graph:/, '');
      let url = `/me/calendars/${encodeURIComponent(calId)}/calendarView?` +
        new URLSearchParams({ startDateTime: fromIso, endDateTime: toIso, $select: select, $top: '200', $orderby: 'start/dateTime' });
      const title = names.get(id) || 'Microsoft 365';
      while (url) {
        // Times in UTC, body as plain text (the description prefill strips invites from text).
        const page = await graph(url, { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' });
        for (const e of page.value || []) {
          // All-day events have no time zone: their dates are the calendar's own, so keep them as local midnights.
          const start = e.isAllDay ? new Date(e.start.dateTime.slice(0, 10) + 'T00:00:00') : new Date(e.start.dateTime + 'Z');
          const end = e.isAllDay ? new Date(e.end.dateTime.slice(0, 10) + 'T00:00:00') : new Date(e.end.dateTime + 'Z');
          out.push({
            uid: e.iCalUId || e.id, title: e.subject || '', start: start.toISOString(), end: end.toISOString(),
            date: localDay(start), allDay: !!e.isAllDay, location: e.location?.displayName || '',
            notes: String(e.body?.content || '').slice(0, 20000), calendar: title, calendarId: id,
            organizer: e.organizer?.emailAddress?.name || '',
            attendees: (e.attendees || []).filter((a) => a.type !== 'resource').map((a) => ({
              name: a.emailAddress?.name || '', email: a.emailAddress?.address || '',
              me: !!me && String(a.emailAddress?.address || '').toLowerCase() === me,
            })),
            canceled: !!e.isCancelled, free: e.showAs === 'free',
          });
        }
        url = page['@odata.nextLink'] || '';
      }
    }
    return out.filter((e) => !e.canceled).map((e) => ({
      ...e,
      id: 'gr_' + crypto.createHash('sha1').update(`${e.uid}|${e.start}`).digest('hex').slice(0, 24),
    }));
  }

  return { calendars, events, startSignIn, status, signOut };
}
