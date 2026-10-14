// SF Desk — local Salesforce account & opportunity editor.
// Talks to the Salesforce REST API using your own OAuth login (PKCE), or, when no
// SF_CLIENT_ID is set, the login you already have in the Salesforce CLI (`sf`).
// Runs on localhost only; tokens live in server memory for the session.
// Records loaded from Salesforce are kept in a local SQLite file (see db.js) so the
// last-seen data can still be shown when Salesforce can't be reached.

import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { isMac, macCalendar } from './macCalendar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const PORT = Number(process.env.PORT || 3000);
// The Outlook add-in needs HTTPS. When the certificate made by scripts/outlook-cert.sh is there, SF Desk also
// listens on https://localhost:HTTPS_PORT (see OUTLOOK.md).
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const CERT_DIR = process.env.SF_DESK_CERTS || path.join(__dirname, 'certs');
const LOGIN_URL = (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').replace(/\/$/, '');
const API = process.env.SF_API_VERSION || 'v62.0';
const CLIENT_ID = process.env.SF_CLIENT_ID;
const CLIENT_SECRET = process.env.SF_CLIENT_SECRET || '';
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const DB_FILE = process.env.SF_DESK_DB || path.join(__dirname, 'data', 'sf-desk.db');
// Without a client ID, sign in by borrowing the Salesforce CLI's login instead of running OAuth here.
const USE_CLI = !CLIENT_ID;
const SF_CLI = process.env.SF_CLI_PATH || 'sf';
const SF_TARGET_ORG = process.env.SF_TARGET_ORG || '';

// Fields the app reads and is allowed to write. Edit these lists to add more.
const ACCOUNT_FIELDS = ['Name', 'Type', 'Industry', 'Phone', 'Website', 'AnnualRevenue',
  'NumberOfEmployees', 'BillingCity', 'BillingState', 'Description'];
const OPP_FIELDS = ['Name', 'StageName', 'Amount', 'CloseDate', 'Probability', 'NextStep', 'Description'];
const ACCOUNT_READ = ['Id', ...ACCOUNT_FIELDS, 'OwnerId', 'Owner.Name', 'LastModifiedDate'];
const OPP_READ = ['Id', 'AccountId', ...OPP_FIELDS, 'IsClosed', 'Owner.Name', 'LastModifiedDate'];

// The "Deal Support" object attached to opportunities. Found by its label unless these name it:
// SF_DEAL_SUPPORT_OBJECT is its API name (e.g. Deal_Support__c), SF_DEAL_SUPPORT_OPP_FIELD its
// lookup to Opportunity (only needed if it has more than one).
const DEAL_SUPPORT_OBJECT = process.env.SF_DEAL_SUPPORT_OBJECT || '';
const DEAL_SUPPORT_OPP_FIELD = process.env.SF_DEAL_SUPPORT_OPP_FIELD || '';
// Which Deal Support fields to show, comma-separated API names. Default: the fields on its page layout.
const DEAL_SUPPORT_FIELDS = (process.env.SF_DEAL_SUPPORT_FIELDS || '').split(',').map((f) => f.trim()).filter(Boolean);
// Deal Support fields the form treats as optional even when the page layout marks them required,
// comma-separated API names; fields labelled like these are included too. Salesforce still rejects the
// save if the field itself (or a validation rule) requires them.
const DEAL_SUPPORT_OPTIONAL = (process.env.SF_DEAL_SUPPORT_OPTIONAL ?? 'IdentityNow_Platform_Modules__c,Integration_Modules_for_SaaS__c')
  .split(',').map((f) => f.trim().toLowerCase()).filter(Boolean);
const optionalByLabel = /platform capabilit|integration modules?/i;
// Field types the Deal Support form knows how to show.
const DS_TYPES = new Set(['string', 'textarea', 'email', 'phone', 'url', 'picklist', 'multipicklist', 'boolean',
  'date', 'datetime', 'double', 'currency', 'percent', 'int', 'reference']);

// The "Lead SE" field used for the "only where I'm Lead SE" filter. Set SF_LEAD_SE_FIELD to its API
// name (e.g. Lead_SE__c) if auto-detection by its label "Lead SE" doesn't find it.
const LEAD_SE_FIELD = process.env.SF_LEAD_SE_FIELD || '';
// The Account fields behind the "My Accounts" filter, comma-separated API names. Default: found by label
// (see MY_ACCOUNT_ROLES). SF_BOAT_FIELD names the "SailPoint BOAT" field if its label doesn't find it.
const MY_ACCOUNT_FIELDS = (process.env.SF_MY_ACCOUNT_FIELDS || '').split(',').map((f) => f.trim()).filter(Boolean);
const BOAT_FIELD = process.env.SF_BOAT_FIELD || '';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const b64url = (buf) => buf.toString('base64url');

const store = openDb(DB_FILE);
const macCal = isMac ? macCalendar(__dirname, path.dirname(DB_FILE)) : null;

const app = express();
app.use(express.json({ limit: '100kb' }));
// Separate sessions for the two listeners (express-session can't share a store between cookie settings).
// Outlook's task pane may be framed by Outlook, so the HTTPS cookie is SameSite=None; writes still need
// the X-SFDesk header (see the API's CSRF guard).
const sessionOpts = { secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), resave: false, saveUninitialized: false };
const httpSession = session({ ...sessionOpts, cookie: { httpOnly: true, sameSite: 'lax' } });
const httpsSession = session({ ...sessionOpts, name: 'sfdesk.sid', cookie: { httpOnly: true, sameSite: 'none', secure: true } });
app.use((req, res, next) => (req.secure ? httpsSession : httpSession)(req, res, next));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Outlook add-in ----------

// The task pane is the app itself with Office.js added; the page sees the path and shows only the
// "create from this meeting" form.
const OFFICE_JS = '<script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>';
app.get('/outlook/pane', (req, res) => {
  const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res.type('html').set('Cache-Control', 'no-store').send(page.replace('<script src="xlsx.js"></script>', `${OFFICE_JS}\n<script src="/xlsx.js"></script>`));
});
// The add-in manifest to sideload, pointing at this server's HTTPS address.
app.get('/outlook/manifest.xml', (req, res) => {
  const xml = fs.readFileSync(path.join(__dirname, 'outlook', 'manifest.xml'), 'utf8');
  res.type('application/xml').set('Content-Disposition', 'attachment; filename="sf-desk-outlook.xml"')
    .send(xml.replaceAll('https://localhost:3443', `https://localhost:${HTTPS_PORT}`));
});

// ---------- Salesforce CLI login ----------

// The sf CLI reads SF_API_VERSION too, and rejects our "v62.0" form, so it doesn't get ours.
const { SF_API_VERSION: _apiVersion, ...CLI_ENV } = process.env;

// Run an sf CLI command with --json and return its parsed output (errors become HttpErrors).
function runCli(args) {
  const target = SF_TARGET_ORG ? ['--target-org', SF_TARGET_ORG] : [];
  return new Promise((resolve, reject) => {
    execFile(SF_CLI, [...args, '--json', ...target], { timeout: 60_000, maxBuffer: 1024 * 1024, env: CLI_ENV }, (err, stdout) => {
      if (err?.code === 'ENOENT') {
        return reject(new HttpError(400, 'Salesforce CLI (sf) not found. Install it, or set SF_CLI_PATH in .env. See README.md.'));
      }
      let out = null;
      try { out = JSON.parse(stdout); } catch { /* handled below */ }
      if (!out?.result) {
        const why = out?.message || err?.message || 'no result returned';
        return reject(new HttpError(401, `Salesforce CLI login not available: ${why}. ` +
          `Run "sf org login web${SF_TARGET_ORG ? ` --alias ${SF_TARGET_ORG}` : ' --set-default'}" and try again.`));
      }
      resolve(out.result);
    });
  });
}

// Ask the sf CLI for a current access token. `org display` refreshes an expired token first.
// Newer CLI versions redact the token there, so fetch it with `org auth show-access-token` instead.
async function cliToken() {
  const org = await runCli(['org', 'display']);
  let token = org.accessToken;
  if (!token || /REDACTED/i.test(token)) token = (await runCli(['org', 'auth', 'show-access-token'])).accessToken;
  if (!token || !org.instanceUrl) {
    throw new HttpError(401, 'Salesforce CLI returned no access token. Run "sf org login web" and try again.');
  }
  return { access_token: token, instance_url: org.instanceUrl.replace(/\/$/, '') };
}

// ---------- OAuth (Web Server flow + PKCE) ----------

app.get('/login', (req, res, next) => {
  if (USE_CLI) return cliLogin(req, res).catch(next);
  // The OAuth callback is registered on http://localhost, whose session the task pane doesn't share.
  if (req.secure) return next(new HttpError(400, 'The Outlook add-in can only connect with the Salesforce CLI login. See OUTLOOK.md.'));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  req.session.pkce = { verifier, state };
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'api refresh_token',
    state,
  });
  res.redirect(`${LOGIN_URL}/services/oauth2/authorize?${params}`);
});

async function cliLogin(req, res) {
  req.session.sf = { ...(await cliToken()), cli: true };
  await loadUser(req);
  // The Outlook task pane comes back to itself.
  res.redirect(String(req.query.next || '').startsWith('/outlook/pane') ? '/outlook/pane' : '/');
}

async function loadUser(req) {
  const me = await sf(req, 'GET', '/services/oauth2/userinfo');
  req.session.sf.user = { id: me.user_id, orgId: me.organization_id, name: me.name, username: me.preferred_username };
}

app.get('/oauth/callback', wrap(async (req, res) => {
  const { code, state, error, error_description: desc } = req.query;
  if (error) throw new HttpError(400, `Salesforce login failed: ${error} ${desc || ''}`);
  const pkce = req.session.pkce;
  if (!pkce || state !== pkce.state) {
    throw new HttpError(400, 'Login state mismatch. Open http://localhost:' + PORT + ' and try again.');
  }
  delete req.session.pkce;

  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.verifier,
  });
  req.session.sf = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    instance_url: tok.instance_url,
  };
  await loadUser(req);
  res.redirect('/');
}));

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, ...params });
  if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET);
  const r = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new HttpError(r.status === 400 ? 401 : 502,
      `Salesforce token error: ${data.error_description || data.error || r.statusText}`);
  }
  return data;
}

async function refreshAccess(req) {
  const t = req.session.sf;
  if (t.cli) {
    try {
      Object.assign(t, await cliToken());
    } catch {
      delete req.session.sf;
      throw new HttpError(401, 'Your Salesforce CLI login expired. Run "sf org login web" again, then reconnect.');
    }
    return;
  }
  try {
    const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    t.access_token = tok.access_token;
    if (tok.instance_url) t.instance_url = tok.instance_url;
  } catch {
    delete req.session.sf;
    throw new HttpError(401, 'Your Salesforce session expired. Reconnect to continue.');
  }
}

// ---------- Salesforce REST helpers ----------

async function sf(req, method, urlPath, { body, headers = {} } = {}, retried = false) {
  const t = req.session.sf;
  if (!t) throw new HttpError(401, 'Not connected to Salesforce');
  let r;
  try {
    r = await fetch(t.instance_url + urlPath, {
      method,
    headers: {
        Authorization: `Bearer ${t.access_token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new HttpError(503, "Can't reach Salesforce. Check your connection and try again.");
  }

  if (r.status === 401 && !retried && (t.refresh_token || t.cli)) {
    await refreshAccess(req);
    return sf(req, method, urlPath, { body, headers }, true);
  }
  if (r.status === 412) {
    throw new HttpError(409, 'Someone changed this record in Salesforce after you loaded it. ' +
      'Reload it to see the latest values, then reapply your edit.');
  }
  if (r.status === 204) return null;

  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!r.ok) {
    const msg = Array.isArray(data)
      ? data.map((e) => e.message + (e.fields?.length ? ` (${e.fields.join(', ')})` : '')).join('; ')
      : data?.message || r.statusText;
    throw new HttpError(r.status === 401 ? 401 : r.status >= 500 ? 502 : r.status, msg);
  }
  return data;
}

function stripAttrs(rec) {
  const { attributes, ...rest } = rec;
  // Related records (Owner, CreatedBy) come back with their own attributes; keep just the fields.
  for (const [k, v] of Object.entries(rest)) if (v && typeof v === 'object' && v.attributes) rest[k] = stripAttrs(v);
  return rest;
}

async function query(req, soql, max = 2000) {
  let data = await sf(req, 'GET', `/services/data/${API}/query?q=${encodeURIComponent(soql)}`);
  const out = [...data.records];
  while (!data.done && data.nextRecordsUrl && out.length < max) {
    data = await sf(req, 'GET', data.nextRecordsUrl);
    out.push(...data.records);
  }
  return out.map(stripAttrs);
}

function sfId(value) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id)) throw new HttpError(400, 'Invalid Salesforce Id');
  return id;
}

// Escape a user string for use inside a SOQL LIKE '%...%' literal.
const soqlLike = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/_/g, '\\_');

// Salesforce returns "2026-10-12T15:48:00.000+0000"; normalise for Date parsing.
const toHttpDate = (sfDate) => new Date(String(sfDate).replace(/\+0000$/, 'Z')).toUTCString();

async function updateRecord(req, sobject, allowed, readFields) {
  const id = sfId(req.params.id);
  const { fields = {}, lastModified } = req.body || {};
  const body = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) throw new HttpError(400, `Field not editable in this app: ${k}`);
    body[k] = v === '' ? null : v;
  }
  if (!Object.keys(body).length) throw new HttpError(400, 'No changes to save');

  // Optimistic concurrency: Salesforce rejects the write (412) if the record changed since we read it.
  const headers = lastModified ? { 'If-Unmodified-Since': toHttpDate(lastModified) } : {};
  await sf(req, 'PATCH', `/services/data/${API}/sobjects/${sobject}/${id}`, { body, headers });
  const [rec] = await query(req, `SELECT ${readFields.join(', ')} FROM ${sobject} WHERE Id = '${id}'`);
  return rec;
}

// ---------- Local SQLite copy ----------

const orgOf = (req) => req.session.sf.user.orgId;

// Run a Salesforce read; if Salesforce is unreachable or erroring, answer from the local copy
// instead, marking the response so the page can say it is showing saved data.
async function withCacheFallback(req, res, live, cached) {
  try {
    return await live();
  } catch (err) {
    if (!(err.status >= 502)) throw err;
    const saved = cached();
    if (!saved) throw err;
    res.set('X-SFDesk-Cached', saved.syncedAt || 'unknown');
    return saved.data;
  }
}

// ---------- Lead SE filter ----------

// Find the Lead SE field on an object: by API name if configured, else by its label.
function findLeadSe(describe) {
  const f = describe.fields.find((x) => LEAD_SE_FIELD
    ? x.name.toLowerCase() === LEAD_SE_FIELD.toLowerCase()
    : /^lead\s*se$/i.test(x.label.trim()));
  return f ? { name: f.name, isUser: f.type === 'reference' } : null;
}

// Look up (once per session, falling back to the saved copy offline) which fields are Lead SE.
async function knownLeadSeFields(req) {
  if (!req.session.leadSe) {
    try {
      const describe = (o) => sf(req, 'GET', `/services/data/${API}/sobjects/${o}/describe`);
      const [acct, opp] = await Promise.all([describe('Account'), describe('Opportunity')]);
      req.session.leadSe = { Account: findLeadSe(acct), Opportunity: findLeadSe(opp) };
      store.saveSetting(orgOf(req), 'leadSe', req.session.leadSe);
    } catch (err) {
      if (!(err.status >= 502)) throw err;
      // Offline and never looked up: reads still work, only the filter itself can't run.
      return store.getSetting(orgOf(req), 'leadSe') || { offline: true };
    }
  }
  return req.session.leadSe;
}

async function leadSeFields(req) {
  const fields = await knownLeadSeFields(req);
  if (fields.offline) throw new HttpError(503, "Can't reach Salesforce to find the Lead SE field. Untick the filter to browse your saved copy.");
  if (!fields.Account && !fields.Opportunity) {
    throw new HttpError(400, 'No "Lead SE" field found on Account or Opportunity. ' +
      'Set SF_LEAD_SE_FIELD in .env to its API name (e.g. Lead_SE__c) and restart.');
  }
  return fields;
}

// The value a Lead SE field holds when it is the signed-in user: User Id for a lookup, else full name.
const leadSeValue = (req, field) => (field.isUser ? req.session.sf.user.id : String(req.session.sf.user.name));

// SOQL condition matching the signed-in user.
function leadSeIsMe(req, field) {
  return field.isUser
    ? `${field.name} = '${sfId(leadSeValue(req, field))}'`
    : `${field.name} = '${leadSeValue(req, field).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// Fields to read for each object, plus its Lead SE field when there is one, so saved records
// carry it and the filter also works on the saved copy offline.
const withField = (base, f) => (f && !base.includes(f.name) ? [...base, f.name] : base);
const accountRead = (lse) => withField(ACCOUNT_READ, lse?.Account);
const oppRead = (lse) => withField(OPP_READ, lse?.Opportunity);

// The same test in JS, for records already loaded (SOQL text comparison ignores case).
function leadSeMatches(req, field, rec) {
  const v = rec[field.name];
  return v != null && String(v).toLowerCase() === leadSeValue(req, field).toLowerCase();
}

// ---------- My Accounts and SailPoint BOAT filters ----------

// An account is "mine" when I'm in any of these roles on it. Each is the Account field with that label
// (an "Account " prefix is optional either way) or API name; Account Owner is always OwnerId.
const MY_ACCOUNT_ROLES = ['Account Owner', 'Lead SE', 'Lead SE Manager', 'ATS', 'DSR', 'CSM', 'CSM Manager', 'Services Manager'];
const roleKey = (s) => String(s).toLowerCase().replace(/__c$/, '').replace(/[_\s]+/g, ' ').trim().replace(/^account /, '');
const isUserRef = (f) => f.type === 'reference' && (f.referenceTo || []).includes('User');
const asFilterField = (f, role) => ({ role, name: f.name, label: f.label, type: f.type, isUser: isUserRef(f),
  relationshipName: f.relationshipName || null });

function findAccountFilters(describe) {
  const fields = describe.fields;
  let mine;
  if (MY_ACCOUNT_FIELDS.length) {
    mine = MY_ACCOUNT_FIELDS.map((n) => fields.find((f) => f.name.toLowerCase() === n.toLowerCase()))
      .filter(Boolean).map((f) => asFilterField(f, f.label));
  } else {
    mine = [];
    for (const role of MY_ACCOUNT_ROLES) {
      const key = roleKey(role);
      // A User lookup beats a text field holding a name; other lookups (e.g. to Contact) can't be me.
      const f = key === 'owner' ? fields.find((x) => x.name === 'OwnerId')
        : fields.filter((x) => (roleKey(x.label) === key || roleKey(x.name) === key) && (isUserRef(x) || x.type === 'string'))
          .sort((a, b) => isUserRef(b) - isUserRef(a))[0];
      if (f && !mine.some((m) => m.name === f.name)) mine.push(asFilterField(f, role));
    }
  }
  const boatF = fields.find((f) => (BOAT_FIELD ? f.name.toLowerCase() === BOAT_FIELD.toLowerCase()
    : /^(sailpoint\s*)?boat$/i.test(f.label.trim()) || /^(sailpoint_?)?boat(__c)?$/i.test(f.name)));
  const boat = boatF && {
    ...asFilterField(boatF, 'SailPoint BOAT'),
    options: boatF.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
      : (boatF.picklistValues || []).filter((v) => v.active).map((v) => ({ value: v.value, label: v.label || v.value })),
  };
  // The SE filter picks one Lead SE: the role field found for Lead SE (else one labelled "Lead SE").
  const seF = mine.find((m) => m.role === 'Lead SE')
    || (() => { const f = fields.find((x) => roleKey(x.label) === 'lead se' && (isUserRef(x) || x.type === 'string')); return f && asFilterField(f, 'Lead SE'); })();
  const se = seF ? { ...seF, options: [] } : null;
  return { v: 2, mine, missing: MY_ACCOUNT_FIELDS.length ? [] : MY_ACCOUNT_ROLES.filter((r) => !mine.some((m) => m.role === r)), boat, se };
}

// Looked up once per session (saved for offline use), like the Lead SE fields.
async function accountFilters(req) {
  if (req.session.acctFilters?.v !== 2) {
    try {
      const describe = await sf(req, 'GET', `/services/data/${API}/sobjects/Account/describe`);
      const found = findAccountFilters(describe);
      // A text BOAT field has no picklist; offer the values accounts actually have.
      if (found.boat && !found.boat.options.length && found.boat.type !== 'textarea') {
        const rows = await query(req, `SELECT ${found.boat.name} v FROM Account WHERE ${found.boat.name} != null ` +
          `GROUP BY ${found.boat.name} ORDER BY ${found.boat.name} LIMIT 200`).catch(() => []);
        found.boat.options = rows.map((r) => ({ value: String(r.v), label: String(r.v) }));
      }
      // The SE choices: everyone who is Lead SE on some account, A–Z.
      if (found.se) {
        const se = found.se;
        const nameCol = se.isUser && se.relationshipName ? `${se.relationshipName}.Name` : null;
        const rows = await query(req, `SELECT ${se.name} v${nameCol ? `, ${nameCol} n` : ''} FROM Account WHERE ${se.name} != null ` +
          `GROUP BY ${se.name}${nameCol ? `, ${nameCol}` : ''} LIMIT 500`).catch(() => []);
        se.options = rows.map((r) => ({ value: String(r.v), label: String(r.n ?? r.v) }))
          .sort((a, b) => a.label.localeCompare(b.label));
      }
      req.session.acctFilters = found;
      store.saveSetting(orgOf(req), 'acctFilters', found);
    } catch (err) {
      if (!(err.status >= 502)) throw err;
      return store.getSetting(orgOf(req), 'acctFilters') || { offline: true, mine: [], missing: [], boat: null, se: null };
    }
  }
  return req.session.acctFilters;
}

const filterFieldNames = (af) => [...(af.mine || []).map((f) => f.name), ...(af.boat ? [af.boat.name] : []),
  ...(af.se ? [af.se.name] : [])];
const soqlStr = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const BLANK = '__blank__';

// SOQL condition for a BOAT choice: a value, or BLANK for accounts without one.
function boatSoql(f, value) {
  if (value === BLANK) return `${f.name} = null`;
  if (f.type === 'boolean') return `${f.name} = ${value === 'true'}`;
  if (f.type === 'multipicklist') return `${f.name} INCLUDES (${soqlStr(value)})`;
  if (['double', 'currency', 'percent', 'int'].includes(f.type) && /^-?\d+(\.\d+)?$/.test(value)) return `${f.name} = ${value}`;
  return `${f.name} = ${soqlStr(value)}`;
}

// ---------- JSON API used by the page ----------

const api = express.Router();

// Simple CSRF guard: writes must carry a custom header, which other sites can't send cross-origin.
api.use((req, res, next) => {
  if (req.method !== 'GET' && req.get('X-SFDesk') !== '1') return next(new HttpError(403, 'Missing request header'));
  next();
});

api.get('/me', (req, res) => {
  const t = req.session.sf;
  res.json(t ? { connected: true, user: t.user, instanceUrl: t.instance_url, version: VERSION } : { connected: false, cli: USE_CLI, version: VERSION });
});

api.post('/logout', wrap(async (req, res) => {
  const t = req.session.sf;
  // A CLI login belongs to the sf CLI; leave it signed in there and just forget it here.
  if (!t?.cli && (t?.refresh_token || t?.access_token)) {
    await fetch(`${LOGIN_URL}/services/oauth2/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.refresh_token || t.access_token }),
    }).catch(() => {});
  }
  req.session.destroy(() => res.json({ ok: true }));
}));

api.use((req, res, next) => (req.session.sf ? next() : next(new HttpError(401, 'Not connected to Salesforce'))));

api.get('/meta', wrap(async (req, res) => {
  if (req.session.meta) return res.json(req.session.meta);
  const meta = await withCacheFallback(req, res, () => loadMeta(req), () => {
    const saved = store.getSetting(orgOf(req), 'meta');
    return saved && { data: saved };
  });
  if (!res.get('X-SFDesk-Cached')) req.session.meta = meta;
  res.json(meta);
}));

async function loadMeta(req) {
  const describe = (o) => sf(req, 'GET', `/services/data/${API}/sobjects/${o}/describe`);
  const [acct, opp] = await Promise.all([describe('Account'), describe('Opportunity')]);
  const picklist = (d, name) =>
    (d.fields.find((f) => f.name === name)?.picklistValues || []).filter((v) => v.active).map((v) => v.value);
  const editable = (d, names) =>
    d.fields.filter((f) => names.includes(f.name) && f.updateable).map((f) => f.name);
  const creatable = (d, names) =>
    d.fields.filter((f) => names.includes(f.name) && f.createable).map((f) => f.name);
  const meta = {
    picklists: {
      Type: picklist(acct, 'Type'),
      Industry: picklist(acct, 'Industry'),
      StageName: picklist(opp, 'StageName'),
    },
    editable: { Account: editable(acct, ACCOUNT_FIELDS), Opportunity: editable(opp, OPP_FIELDS) },
    canCreateOpportunity: opp.createable && creatable(opp, ['Name', 'StageName', 'CloseDate']).length === 3,
  };
  store.saveSetting(orgOf(req), 'meta', meta);
  return meta;
}

api.get('/accounts', wrap(async (req, res) => {
  const where = [];
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) where.push(`Name LIKE '%${soqlLike(q)}%'`);
  // Sales rep filter: the account owner.
  const owner = req.query.owner ? sfId(req.query.owner) : '';
  if (owner) where.push(`OwnerId = '${owner}'`);
  // A–Z by name unless sort=recent asks for most recently modified first.
  const recent = req.query.sort === 'recent';
  const af = await accountFilters(req);
  // My Accounts: I'm in any of the account's role fields.
  const mine = req.query.mine === '1';
  if (mine) {
    if (af.offline) throw new HttpError(503, "Can't reach Salesforce to find the My Accounts fields. Pick All accounts to browse your saved copy.");
    if (!af.mine.length) throw new HttpError(400, 'None of the My Accounts fields were found on Account. Set SF_MY_ACCOUNT_FIELDS in .env to their API names and restart.');
    where.push(`(${af.mine.map((f) => `${f.name} = ${f.isUser ? `'${sfId(req.session.sf.user.id)}'` : soqlStr(req.session.sf.user.name)}`).join(' OR ')})`);
  }
  const boatValue = String(req.query.boat || '').slice(0, 255);
  const boat = boatValue && af.boat ? { field: af.boat, value: boatValue } : null;
  if (boat) where.push(boatSoql(boat.field, boat.value));
  // SE filter: one Lead SE (a User Id for a lookup, else the name the field holds).
  const seValue = String(req.query.se || '').slice(0, 255);
  const se = seValue && af.se ? { field: af.se, value: af.se.isUser ? sfId(seValue) : seValue } : null;
  if (se) where.push(`${se.field.name} = ${soqlStr(se.value)}`);
  // Read the filter fields too, so the saved copy can apply the same filters offline.
  const fields = [...new Set(['Id', 'Name', 'Type', 'Industry', 'BillingCity', 'BillingState', 'OwnerId', 'Owner.Name', 'LastModifiedDate',
    ...filterFieldNames(af)])];
  const soql = `SELECT ${fields.join(', ')} ` +
    `FROM Account ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${recent ? 'LastModifiedDate DESC' : 'Name ASC'} LIMIT 200`;

  res.json(await withCacheFallback(req, res, async () => {
    const accounts = await query(req, soql);
    store.saveAccounts(orgOf(req), accounts);
    return accounts;
  }, () => {
    const saved = store.listAccounts(orgOf(req), {
      q,
      ownerId: owner,
      recent,
      mine: mine ? af.mine.map((f) => ({ field: f.name, value: f.isUser ? req.session.sf.user.id : String(req.session.sf.user.name) })) : null,
      match: [
        boat && { field: boat.field.name, value: boat.value, type: boat.field.type, blank: boat.value === BLANK },
        se && { field: se.field.name, value: se.value },
      ].filter(Boolean),
    });
    return { data: saved.records, syncedAt: saved.syncedAt };
  }));
}));

// The SEs and sales reps (account owners) with accounts in one SailPoint BOAT, so the page can narrow
// those dropdowns to that BOAT.
api.get('/account-filters/people', wrap(async (req, res) => {
  const af = await accountFilters(req);
  const value = String(req.query.boat || '').slice(0, 255);
  if (!af.boat || !value) throw new HttpError(400, 'Pick a SailPoint BOAT');
  const where = boatSoql(af.boat, value);
  const byLabel = (a, b) => a.label.localeCompare(b.label);
  const seNames = new Map((af.se?.options || []).map((o) => [o.value, o.label]));
  res.json(await withCacheFallback(req, res, async () => {
    const se = af.se;
    const seName = se?.isUser && se.relationshipName ? `${se.relationshipName}.Name` : null;
    const [ses, reps] = await Promise.all([
      se ? query(req, `SELECT ${se.name} v${seName ? `, ${seName} n` : ''} FROM Account WHERE ${where} AND ${se.name} != null ` +
        `GROUP BY ${se.name}${seName ? `, ${seName}` : ''} LIMIT 500`) : [],
      query(req, `SELECT OwnerId v, Owner.Name n FROM Account WHERE ${where} GROUP BY OwnerId, Owner.Name LIMIT 2000`),
    ]);
    return {
      se: ses.map((r) => ({ value: String(r.v), label: String(r.n ?? seNames.get(String(r.v)) ?? r.v) })).sort(byLabel),
      reps: reps.map((r) => ({ value: String(r.v), label: String(r.n ?? r.v) })).sort(byLabel),
    };
  }, () => {
    // Offline: the people on the saved accounts in that BOAT.
    const saved = store.listAccounts(orgOf(req), {
      match: [{ field: af.boat.name, value, type: af.boat.type, blank: value === BLANK }], limit: 100000 });
    const se = new Map(), reps = new Map();
    for (const a of saved.records) {
      const v = af.se && a[af.se.name];
      if (v) se.set(String(v), seNames.get(String(v)) || String(v));
      if (a.OwnerId) reps.set(a.OwnerId, a.Owner?.Name || a.OwnerId);
    }
    const list = (m) => [...m].map(([v, label]) => ({ value: v, label })).sort(byLabel);
    return { data: { se: list(se), reps: list(reps) }, syncedAt: saved.syncedAt };
  }));
}));

// Which fields the Accounts filters use, and the SailPoint BOAT choices, for the page.
api.get('/account-filters', wrap(async (req, res) => {
  const af = await accountFilters(req);
  res.json({ mine: af.mine.map(({ role, name, label }) => ({ role, name, label })), missing: af.missing,
    boat: af.boat && { name: af.boat.name, label: af.boat.label, options: af.boat.options },
    se: af.se && { name: af.se.name, label: af.se.label, options: af.se.options }, offline: !!af.offline });
}));

api.get('/accounts/:id', wrap(async (req, res) => {
  const id = sfId(req.params.id);
  const known = await knownLeadSeFields(req);
  const lse = req.query.leadse === '1' ? await leadSeFields(req) : null;
  // Load and save every opportunity on the account, so the saved copy stays complete whichever
  // way the filter is set, then apply the Lead SE filter here.
  const onlyMine = (detail) => (lse?.Opportunity
    ? { ...detail, opportunities: detail.opportunities.filter((o) => leadSeMatches(req, lse.Opportunity, o)) }
    : detail);
  res.json(await withCacheFallback(req, res, async () => {
    const fields = [...new Set([...accountRead(known), ...filterFieldNames(await accountFilters(req))])];
    const [account] = await query(req, `SELECT ${fields.join(', ')} FROM Account WHERE Id = '${id}'`);
    if (!account) throw new HttpError(404, 'Account not found');
    const opportunities = await query(req,
      `SELECT ${oppRead(known).join(', ')} FROM Opportunity WHERE AccountId = '${id}' ORDER BY IsClosed ASC, CloseDate ASC`);
    store.saveAccountDetail(orgOf(req), account, opportunities);
    return onlyMine({ account, opportunities });
  }, () => {
    const saved = store.getAccountDetail(orgOf(req), id);
    return saved && { data: onlyMine({ account: saved.account, opportunities: saved.opportunities }), syncedAt: saved.syncedAt };
  }));
}));

api.patch('/accounts/:id', wrap(async (req, res) => {
  const rec = await updateRecord(req, 'Account', ACCOUNT_FIELDS,
    [...new Set([...accountRead(await knownLeadSeFields(req)), ...filterFieldNames(await accountFilters(req))])]);
  store.saveAccounts(orgOf(req), [rec], { replace: true });
  res.json(rec);
}));

api.patch('/opportunities/:id', wrap(async (req, res) => {
  const rec = await updateRecord(req, 'Opportunity', OPP_FIELDS, oppRead(await knownLeadSeFields(req)));
  store.saveOpportunities(orgOf(req), [rec]);
  res.json(rec);
}));

api.post('/opportunities', wrap(async (req, res) => {
  const fields = req.body?.fields || {};
  const body = { AccountId: sfId(fields.AccountId) };
  for (const k of OPP_FIELDS) if (fields[k] !== undefined && fields[k] !== '' && fields[k] !== null) body[k] = fields[k];
  for (const k of ['Name', 'StageName', 'CloseDate']) if (!body[k]) throw new HttpError(400, `${k} is required`);
  const created = await sf(req, 'POST', `/services/data/${API}/sobjects/Opportunity`, { body });
  const [rec] = await query(req, `SELECT ${oppRead(await knownLeadSeFields(req)).join(', ')} FROM Opportunity WHERE Id = '${sfId(created.id)}'`);
  store.saveOpportunities(orgOf(req), [rec]);
  res.status(201).json(rec);
}));

// ---------- Deal Support ----------

// Find the Deal Support object, its lookup to Opportunity, and the fields the form can show.
// The object's plural label. Some orgs set it to the singular ("Deal Support"); add the "s" ourselves then.
function pluralLabel(d) {
  const one = String(d.label || '').trim(), many = String(d.labelPlural || '').trim();
  if (many && many.toLowerCase() !== one.toLowerCase()) return many;
  return /(s|x|ch|sh)$/i.test(one) ? one + 'es' : /[^aeiou]y$/i.test(one) ? one.slice(0, -1) + 'ies' : one + 's';
}

// What an event's WhatId points to: What.Type when Salesforce gives it, else the Id's key prefix.
const whatType = (e) => e.What?.Type || ({ '006': 'Opportunity', '001': 'Account' })[String(e.WhatId || '').slice(0, 3)] || '';

async function dealSupportMeta(req) {
  if (req.session.dealSupport) return req.session.dealSupport;
  const { sobjects } = await sf(req, 'GET', `/services/data/${API}/sobjects`);
  const obj = DEAL_SUPPORT_OBJECT
    ? sobjects.find((o) => o.name.toLowerCase() === DEAL_SUPPORT_OBJECT.toLowerCase())
    : sobjects.filter((o) => /^deal\s*supports?$/i.test(o.label.trim()) || /^deal\s*supports$/i.test(o.labelPlural.trim()))
      .sort((a, b) => b.custom - a.custom)[0];
  if (!obj) {
    throw new HttpError(404, 'No "Deal Support" object found in your org, or your user can\'t see it. ' +
      'Set SF_DEAL_SUPPORT_OBJECT in .env to its API name (e.g. Deal_Support__c) and restart.');
  }
  const d = await sf(req, 'GET', `/services/data/${API}/sobjects/${obj.name}/describe`);
  const lookups = d.fields.filter((f) => f.type === 'reference' && f.referenceTo.includes('Opportunity'));
  const opp = DEAL_SUPPORT_OPP_FIELD
    ? lookups.find((f) => f.name.toLowerCase() === DEAL_SUPPORT_OPP_FIELD.toLowerCase())
    : lookups.sort((a, b) => b.createable - a.createable)[0];
  if (!opp) {
    throw new HttpError(404, `${d.label} has no lookup to Opportunity. ` +
      'Set SF_DEAL_SUPPORT_OPP_FIELD in .env to the field that links it to an opportunity and restart.');
  }
  const shown = await dealSupportLayout(req, d.name);
  const byName = new Map(d.fields.map((f) => [f.name.toLowerCase(), f]));
  // Fields in layout (or configured) order, then the record name if the layout left it out.
  const picked = shown
    ? [...shown.map((x) => ({ f: byName.get(x.name.toLowerCase()), required: x.required, onForm: x.onForm })),
      ...d.fields.filter((f) => f.nameField).map((f) => ({ f }))]
    : d.fields.filter((f) => f.createable || f.nameField).map((f) => ({ f }));
  // Meeting Overview always holds the same text as Description of Request: the server copies it on
  // create and save, so it stays off the form.
  const textarea = (re, name) => d.fields.find((f) => f.type === 'textarea' && (f.name === name || re.test(f.label)));
  const descOfRequest = textarea(/^description of (the )?request$/i, 'Description_of_Request__c');
  const overview = descOfRequest && textarea(/^meeting overview$/i, 'Meeting_Overview__c');
  const mirror = overview?.createable && overview !== descOfRequest
    ? { from: descOfRequest.name, to: overview.name, length: overview.length || 32768, updateable: !!overview.updateable } : null;
  const fields = picked
    .filter(({ f }, i, all) => f && f.name !== opp.name && f.name !== mirror?.to && DS_TYPES.has(f.type) &&
      all.findIndex((x) => x.f === f) === i)
    .map(({ f, required, onForm = true }) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      createable: f.createable && onForm,
      updateable: !!f.updateable,
      required: f.createable && onForm && f.type !== 'boolean' && (!f.nillable && !f.defaultedOnCreate ||
        (!!required && !DEAL_SUPPORT_OPTIONAL.includes(f.name.toLowerCase()) && !optionalByLabel.test(f.label))),
      length: f.length || null,
      referenceTo: f.referenceTo?.length ? f.referenceTo : null,
      relationshipName: f.type === 'reference' ? f.relationshipName || null : null,
      picklist: f.picklistValues?.length ? f.picklistValues.filter((v) => v.active).map((v) => v.value) : null,
      defaultValue: f.defaultValue ?? null,
    }));
  // Time spent is entered up front: customer-facing (meeting) time, internal (prep) time and travel time,
  // added from the object's fields when the layout leaves them off, in that order, out of "More fields".
  const timeEntry = [
    (f) => f.name === 'Meeting_Duration__c' || /customer facing time|meeting duration/i.test(f.label),
    (f) => f.name === 'Prep_Time__c' || /internal time|prep(aration)? time/i.test(f.label),
    (f) => f.name === 'Travel_Time__c' || /travel time/i.test(f.label),
  ].map((test) => d.fields.find((f) => test(f) && f.createable && ['double', 'int', 'currency', 'percent'].includes(f.type)))
    .filter(Boolean);
  for (const f of timeEntry) {
    let entry = fields.find((x) => x.name === f.name);
    if (!entry) {
      entry = { name: f.name, label: f.label, type: f.type, createable: true, updateable: !!f.updateable, required: false, length: null,
        referenceTo: null, picklist: null, defaultValue: null };
      fields.push(entry);
    }
    entry.createable = true;
    entry.timeEntry = true;
  }

  // Description of Request is always on the form, up front, even when the layout leaves it off.
  if (descOfRequest?.createable) {
    let entry = fields.find((x) => x.name === descOfRequest.name);
    if (!entry) {
      entry = { name: descOfRequest.name, label: descOfRequest.label, type: 'textarea', createable: true, updateable: !!descOfRequest.updateable,
        required: false, length: descOfRequest.length || null, referenceTo: null, picklist: null, defaultValue: null };
      fields.push(entry);
    }
    entry.createable = true;
    entry.upFront = true;
  }

  // New Deal Supports default Role to "Lead SE" (matched ignoring case) when the picklist has it.
  const role = fields.find((f) => f.picklist && (f.name === 'Role__c' || /^role$/i.test(f.label)));
  const leadSe = role?.picklist.find((v) => v.trim().toLowerCase() === 'lead se');
  if (leadSe) role.defaultValue = leadSe;
  const meta = {
    object: d.name,
    label: d.label,
    labelPlural: pluralLabel(d),
    oppField: opp.name,
    roleDefault: role ? { field: role.name, value: leadSe || null, options: role.picklist } : null,
    canCreate: d.createable && opp.createable,
    canUpdate: !!d.updateable,
    canDelete: !!d.deletable,
    oppUpdateable: !!opp.updateable,
    oppRel: opp.relationshipName || null,
    mirror,
    fields,
  };
  req.session.dealSupport = meta;
  return meta;
}

// The fields to show for Deal Support, as [{ name, required, onForm }]: SF_DEAL_SUPPORT_FIELDS if set,
// else the fields on the page layout for the user's default record type. Null means "all fields".
async function dealSupportLayout(req, object) {
  if (DEAL_SUPPORT_FIELDS.length) return DEAL_SUPPORT_FIELDS.map((name) => ({ name, required: false }));
  const get = async (suffix = '') => {
    try {
      return await sf(req, 'GET', `/services/data/${API}/sobjects/${object}/describe/layouts${suffix}`);
    } catch (err) {
      if (err.status === 401 || err.status >= 502) throw err;
      return null;
    }
  };
  const desc = await get();
  const mapping = desc?.recordTypeMappings?.find((m) => m.defaultRecordTypeMapping && m.available);
  let layout = (mapping && desc.layouts?.find((l) => l.id === mapping.layoutId)) || desc?.layouts?.[0];
  // Objects with record types list no layouts here; fetch the default record type's layout by its Id.
  if (!layout && mapping?.recordTypeId) layout = await get('/' + sfId(mapping.recordTypeId));
  if (!layout) return null;
  const out = [];
  for (const section of layout.editLayoutSections || []) {
    for (const row of section.layoutRows || []) {
      for (const item of row.layoutItems || []) {
        for (const c of item.layoutComponents || []) {
          if (c.type === 'Field') out.push({ name: c.value, required: item.required, onForm: item.editableForNew });
        }
      }
    }
  }
  return out.length ? out : null;
}

const dsReadFields = (meta) =>
  ['Id', 'CreatedDate', 'CreatedBy.Name', 'Owner.Name', ...meta.fields.map((f) => f.name)]
    .filter((f, i, all) => all.indexOf(f) === i);

async function listDealSupports(req, meta, oppId, extraWhere = '') {
  // Not every custom object has an owner (master-detail children don't); retry without it.
  const run = (fields) => query(req, `SELECT ${fields.join(', ')} FROM ${meta.object} ` +
    `WHERE ${meta.oppField} = '${oppId}'${extraWhere} ORDER BY CreatedDate DESC`, 500);
  try {
    return await run(dsReadFields(meta));
  } catch (err) {
    if (err.status !== 400) throw err;
    return run(dsReadFields(meta).filter((f) => f !== 'Owner.Name'));
  }
}

api.get('/deal-supports/meta', wrap(async (req, res) => res.json(await dealSupportMeta(req))));

api.get('/opportunities/:id/deal-supports', wrap(async (req, res) => {
  const id = sfId(req.params.id);
  const meta = await dealSupportMeta(req);
  res.json(await listDealSupports(req, meta, id));
}));

// Create a Deal Support on an opportunity from the form's fields. `extra` holds fields the server
// itself sets (e.g. the Assigned SE from My Calendar), used only when the form didn't set them.
async function createDealSupport(req, meta, oppId, fields, extra = {}) {
  if (!meta.canCreate) throw new HttpError(403, `Your Salesforce user can't create ${meta.labelPlural}.`);
  const byName = new Map(meta.fields.filter((f) => f.createable).map((f) => [f.name, f]));
  const body = { [meta.oppField]: oppId };
  for (const [k, v] of Object.entries(fields || {})) {
    if (!byName.has(k)) throw new HttpError(400, `Field not settable in this app: ${k}`);
    if (v !== '' && v !== null && v !== undefined) body[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (body[k] === undefined) body[k] = v;
  if (meta.mirror && body[meta.mirror.from] != null) body[meta.mirror.to] = String(body[meta.mirror.from]).slice(0, meta.mirror.length);
  const missing = [...byName.values()].filter((f) => f.required && body[f.name] === undefined);
  if (missing.length) throw new HttpError(400, 'Required: ' + missing.map((f) => f.label).join(', '));
  const created = await sf(req, 'POST', `/services/data/${API}/sobjects/${meta.object}`, { body });
  const [rec] = await listDealSupports(req, meta, oppId, ` AND Id = '${sfId(created.id)}'`);
  return rec || { Id: created.id };
}

api.post('/opportunities/:id/deal-supports', wrap(async (req, res) => {
  const id = sfId(req.params.id);
  const meta = await dealSupportMeta(req);
  res.status(201).json(await createDealSupport(req, meta, id, req.body?.fields));
}));

// One Deal Support with the form's fields and its opportunity, for the edit form.
api.get('/deal-supports/:id', wrap(async (req, res) => {
  const id = sfId(req.params.id);
  const meta = await dealSupportMeta(req);
  // Total hours too (a formula, not on the form), for the summary shown before the form.
  const hoursF = (await timeMeta(req).catch(() => null))?.hoursFields[0];
  const fields = [...dsReadFields(meta), meta.oppField, ...(meta.oppRel ? [`${meta.oppRel}.Name`, `${meta.oppRel}.Account.Name`] : []),
    ...(hoursF ? [hoursF.name] : [])];
  // Lookup fields are shown with the related record's name; carry on without them if one can't be read.
  const names = meta.fields.filter((f) => f.relationshipName).map((f) => `${f.relationshipName}.Name`);
  const run = (f) => query(req, `SELECT ${[...new Set(f)].join(', ')} FROM ${meta.object} WHERE Id = '${id}'`);
  const [rec] = await run([...fields, ...names]).catch((err) => {
    if (err.status !== 400) throw err;
    return run(fields);
  });
  if (!rec) throw new HttpError(404, `${meta.label} not found.`);
  const opp = meta.oppRel && rec[meta.oppRel];
  res.json({ record: rec, opportunity: rec[meta.oppField]
    ? { Id: rec[meta.oppField], Name: opp?.Name || rec[meta.oppField], Account: { Name: opp?.Account?.Name || '' } } : null,
    description: meta.mirror ? rec[meta.mirror.from] ?? null : null,
    hours: hoursF ? { value: rec[hoursF.name] ?? null, unit: hoursF.unit } : null });
}));

// Save changes to a Deal Support from the edit form: the form's fields (null clears one). Its opportunity stays:
// to move one, remove it and create a new one.
api.patch('/deal-supports/:id', wrap(async (req, res) => {
  const id = sfId(req.params.id);
  const meta = await dealSupportMeta(req);
  if (!meta.canUpdate) throw new HttpError(403, `Your Salesforce user can't edit ${meta.labelPlural}.`);
  const byName = new Map(meta.fields.filter((f) => f.createable && f.updateable).map((f) => [f.name, f]));
  const body = {};
  for (const [k, v] of Object.entries(req.body?.fields || {})) {
    const f = byName.get(k);
    if (!f) throw new HttpError(400, `Field not editable in this app: ${k}`);
    if ((v === '' || v == null) && f.required) throw new HttpError(400, `Required: ${f.label}`);
    body[k] = v === '' || v === undefined ? null : v;
  }
  if (meta.mirror?.updateable && meta.mirror.from in body) {
    body[meta.mirror.to] = body[meta.mirror.from] == null ? null : String(body[meta.mirror.from]).slice(0, meta.mirror.length);
  }
  if (Object.keys(body).length) await sf(req, 'PATCH', `/services/data/${API}/sobjects/${meta.object}/${id}`, { body });
  res.json({ ok: true });
}));

// Delete a Deal Support in Salesforce, and forget any calendar event it was created from.
api.delete('/deal-supports/:id', wrap(async (req, res) => {
  const id = sfId(req.params.id);
  const meta = await dealSupportMeta(req);
  if (!meta.canDelete) throw new HttpError(403, `Your Salesforce user can't delete ${meta.labelPlural}.`);
  await sf(req, 'DELETE', `/services/data/${API}/sobjects/${meta.object}/${id}`);
  store.unlinkDealSupport(orgOf(req), id);
  res.json({ ok: true });
}));

// Move My Time: my Deal Supports (Assigned SE = me) on a closed opportunity, and the open opportunities on
// the same account they can be moved to. Only the opportunity lookup changes; the account lookup stays.
async function myTimeOn(req, oppId) {
  const ds = await dealSupportMeta(req);
  const tm = await timeMeta(req);
  const by = tm.userFields[0], hours = tm.hoursFields[0], date = tm.dateFields[0];
  const [opp] = await query(req, `SELECT Id, Name, AccountId, Account.Name, IsClosed FROM Opportunity WHERE Id = '${oppId}'`);
  if (!opp) throw new HttpError(404, 'Opportunity not found');
  const records = await query(req, `SELECT ${[...new Set(['Id', 'Name', date.name, hours.name])].join(', ')} FROM ${ds.object} ` +
    `WHERE ${ds.oppField} = '${oppId}' AND ${by.name} = '${sfId(req.session.sf.user.id)}' ORDER BY ${date.name} DESC NULLS LAST`, 2000);
  // Everyone else's on this opportunity stay; counted only so the page can say so.
  const others = await sf(req, 'GET', `/services/data/${API}/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${ds.object} ` +
    `WHERE ${ds.oppField} = '${oppId}' AND (${by.name} != '${sfId(req.session.sf.user.id)}' OR ${by.name} = null)`)}`)
    .then((r) => r.totalSize, () => null);
  return { ds, opp, by, hours, date, records, others };
}

api.get('/opportunities/:id/move-time', wrap(async (req, res) => {
  const { ds, opp, by, hours, date, records, others } = await myTimeOn(req, sfId(req.params.id));
  const targets = opp.AccountId ? await query(req, 'SELECT Id, Name, StageName, CloseDate FROM Opportunity ' +
    `WHERE AccountId = '${sfId(opp.AccountId)}' AND IsClosed = false AND Id != '${opp.Id}' ORDER BY CloseDate ASC`) : [];
  res.json({
    label: ds.label, labelPlural: ds.labelPlural, canMove: ds.canUpdate && ds.oppUpdateable,
    from: { Id: opp.Id, Name: opp.Name, IsClosed: opp.IsClosed, accountName: opp.Account?.Name || '' },
    mineLabel: by.label, hoursUnit: hours.unit, others,
    records: records.map((r) => ({ Id: r.Id, Name: r.Name, date: String(r[date.name] || '').slice(0, 10), hours: r[hours.name] ?? null })),
    targets,
  });
}));

// Move my Deal Supports from one opportunity to another open one on the same account. `ids` are the
// ones the page showed when asking; only those still mine and still on fromOppId move.
api.post('/deal-supports/move', wrap(async (req, res) => {
  const fromId = sfId(req.body?.fromOppId), toId = sfId(req.body?.toOppId);
  if (fromId === toId) throw new HttpError(400, 'Pick a different opportunity to move to.');
  const { ds, opp, records } = await myTimeOn(req, fromId);
  if (!ds.canUpdate || !ds.oppUpdateable) throw new HttpError(403, `Your Salesforce user can't change the opportunity on ${ds.labelPlural}.`);
  const [to] = await query(req, `SELECT Id, Name, AccountId, IsClosed FROM Opportunity WHERE Id = '${toId}'`);
  if (!to) throw new HttpError(404, 'Opportunity to move to not found');
  if (to.IsClosed) throw new HttpError(400, `"${to.Name}" is closed. Pick an open opportunity.`);
  if (!opp.AccountId || to.AccountId !== opp.AccountId) throw new HttpError(400, `"${to.Name}" is on a different account.`);
  const asked = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(sfId)) : null;
  const moving = records.filter((r) => !asked || asked.has(r.Id));
  const moved = [], failed = [];
  for (const r of moving) {
    try {
      await sf(req, 'PATCH', `/services/data/${API}/sobjects/${ds.object}/${sfId(r.Id)}`, { body: { [ds.oppField]: to.Id } });
      moved.push({ Id: r.Id, Name: r.Name });
    } catch (err) {
      if (err.status === 401) throw err;
      failed.push({ Id: r.Id, Name: r.Name, error: err.message });
    }
  }
  res.json({ to: { Id: to.Id, Name: to.Name }, moved, failed });
}));

// ---------- Pipeline dashboard ----------

// Every open opportunity on My Accounts (or all you can see with mine=0), for the Deals tab: the
// opportunities whose account has me in any of its role fields, like the Accounts tab's My Accounts.
// The page leaves out hidden records and does the totals.
const PIPELINE_READ = ['Id', 'Name', 'AccountId', 'Account.Name', 'StageName', 'Amount', 'CloseDate', 'Probability',
  'ForecastCategoryName', 'IsClosed', 'Owner.Name', 'LastModifiedDate'];

api.get('/pipeline', wrap(async (req, res) => {
  const known = await knownLeadSeFields(req);
  const af = await accountFilters(req);
  const mine = req.query.mine === '1';
  if (mine) {
    if (af.offline) throw new HttpError(503, "Can't reach Salesforce to find the My Accounts fields. Pick All accounts to browse your saved copy.");
    if (!af.mine.length) throw new HttpError(400, 'None of the My Accounts fields were found on Account. Set SF_MY_ACCOUNT_FIELDS in .env to their API names and restart.');
  }
  const meValue = (f) => (f.isUser ? req.session.sf.user.id : String(req.session.sf.user.name));
  const where = ['IsClosed = false'];
  if (mine) where.push(`(${af.mine.map((f) => `Account.${f.name} = ${f.isUser ? `'${sfId(meValue(f))}'` : soqlStr(meValue(f))}`).join(' OR ')})`);
  const run = (fields) => query(req, `SELECT ${withField(fields, known.Opportunity).join(', ')} FROM Opportunity ` +
    `WHERE ${where.join(' AND ')} ORDER BY CloseDate ASC`, 5000);
  res.json(await withCacheFallback(req, res, async () => {
    let opportunities;
    try {
      opportunities = await run(PIPELINE_READ);
    } catch (err) {
      // Forecast category can be switched off or hidden by field security; carry on without it.
      if (err.status !== 400) throw err;
      opportunities = await run(PIPELINE_READ.filter((f) => f !== 'ForecastCategoryName'));
    }
    store.saveOpportunities(orgOf(req), opportunities, { merge: true });
    return { opportunities, mineFiltered: mine };
  }, () => {
    const saved = store.listOpenOpportunities(orgOf(req), { mine: mine ? af.mine.map((f) => ({ field: f.name, value: meValue(f) })) : null });
    return { data: { opportunities: saved.records, mineFiltered: mine }, syncedAt: saved.syncedAt };
  }));
}));

// ---------- My Time ----------

// Time is logged as Deal Supports. The fields holding the activity date, the time spent and the
// person who did it are picked from the object's fields (SF_TIME_DATE_FIELD, SF_TIME_HOURS_FIELD and
// SF_TIME_USER_FIELD pin them); the page can switch to any of the other candidates it is sent.
const TIME_DATE_FIELD = process.env.SF_TIME_DATE_FIELD || '';
const TIME_HOURS_FIELD = process.env.SF_TIME_HOURS_FIELD || '';
const TIME_USER_FIELD = process.env.SF_TIME_USER_FIELD || '';
// Without those settings these fields are the defaults when the object has them (Kerry's org);
// otherwise the best candidate by record count is picked.
const TIME_USER_DEFAULT = TIME_USER_FIELD || 'Regional_SE_IDN__c';
const TIME_HOURS_DEFAULT = TIME_HOURS_FIELD || 'Total_Time_Hours__c';
const TIME_DATE_DEFAULT = TIME_DATE_FIELD || 'Date_of_Sales_Activity__c';

// Highest score first; fields scoring 0 aren't offered.
const pickFields = (fields, score, pinned, max = 8) => {
  const ranked = fields.map((f) => ({ f, s: pinned && f.name.toLowerCase() === pinned.toLowerCase() ? 100 : score(f) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.f);
  return ranked.slice(0, max);
};

// Reorder candidates by how many of my records fill them (most first, score breaking ties), dropping
// the empty ones unless all are empty. A pinned field stays first. Counts that fail leave the order as is.
function byCount(fields, counts, pinned) {
  if (!counts) return fields;
  const withCount = fields.map((f, i) => ({ f, i, n: counts[i] ?? -1 }));
  const isPinned = (f) => pinned && f.name.toLowerCase() === pinned.toLowerCase();
  const filled = withCount.filter((x) => x.n !== 0 || isPinned(x.f));
  return (filled.length ? filled : withCount)
    .sort((a, b) => isPinned(b.f) - isPinned(a.f) || b.n - a.n || a.i - b.i)
    .map((x) => ({ ...x.f, count: x.n >= 0 ? x.n : null }));
}

// What a time field is measured in: numbers are hours unless the field says minutes; text is parsed.
function timeUnit(f) {
  if (!['double', 'int'].includes(f.type)) return 'text';
  const words = `${f.label} ${f.name}`;
  if (/minute|\bmins?\b/i.test(words)) return 'minutes';
  if (!/hour|hrs/i.test(words) && /minute/i.test(f.inlineHelpText || '') && !/hour/i.test(f.inlineHelpText || '')) return 'minutes';
  return 'hours';
}

async function timeMeta(req) {
  if (req.session.timeMeta) return req.session.timeMeta;
  const ds = await dealSupportMeta(req);
  const d = await sf(req, 'GET', `/services/data/${API}/sobjects/${ds.object}/describe`);
  const opp = d.fields.find((f) => f.name === ds.oppField);
  const text = (f) => `${f.label} ${f.name}`;

  const dates = pickFields(d.fields.filter((f) => f.type === 'date' || f.type === 'datetime'), (f) =>
    f.name === 'Date_of_Sales_Activity__c' ? 10
      : /activity/i.test(text(f)) && /date/i.test(text(f)) ? 8
      : f.custom && f.type === 'date' ? 5
      : f.name === 'CreatedDate' ? 2 : 0, TIME_DATE_DEFAULT);
  // Hours: numeric or text fields named like time spent; never rates, costs or amounts.
  const hourCands = pickFields(d.fields.filter((f) => ['double', 'int', 'picklist', 'string'].includes(f.type) &&
    !/\brate\b|usd|\bcost|price|amount|revenue|percent|\$/i.test(text(f))), (f) => {
    const t = text(f), num = ['double', 'int'].includes(f.type) ? 0.5 : 0;
    if (/total/i.test(t) && /hour|hrs|time/i.test(t)) return 9 + num;
    if (f.name === 'Meeting_Duration__c') return 8 + num;
    if (/hour|hrs/i.test(t)) return 6 + num;
    if (/duration|time spent|minutes|customer facing time|prep time|travel time|effort/i.test(t)) return 4 + num;
    return 0;
  }, TIME_HOURS_DEFAULT, 20);
  // Mine: every user lookup, ranked by how many records have me in it.
  const userCands = pickFields(d.fields.filter((f) => f.type === 'reference' && f.referenceTo?.includes('User') && f.name !== 'LastModifiedById'), (f) =>
    f.custom && /assigned\s*se\b/i.test(f.label) ? 10
      : f.custom && /\bSE\b|sales engineer|engineer|consultant|resource|assigned|performed|specialist/i.test(f.label) ? 9
      : f.name === 'OwnerId' ? 7
      : f.custom ? 5
      : f.name === 'CreatedById' ? 3 : 0, TIME_USER_DEFAULT, 40);
  if (!hourCands.length) {
    throw new HttpError(404, `No hours or duration field found on ${d.label}. ` +
      'Set SF_TIME_HOURS_FIELD in .env to the field that holds the time spent and restart.');
  }
  if (!userCands.length) throw new HttpError(404, `No user lookup found on ${d.label} to tell which records are yours.`);
  const me = sfId(req.session.sf.user.id);
  const total = (soql) => sf(req, 'GET', `/services/data/${API}/query?q=${encodeURIComponent(soql)}`);
  const userCounts = await Promise.all(userCands.map((f) =>
    total(`SELECT COUNT() FROM ${d.name} WHERE ${f.name} = '${me}'`).then((r) => r.totalSize, () => -1)));
  const users = byCount(userCands, userCounts, TIME_USER_DEFAULT).slice(0, 8);
  // How many of my records (by the top user field) have each hours field filled.
  const hourCounts = await total(`SELECT ${hourCands.map((f, i) => `COUNT(${f.name}) c${i}`).join(', ')} ` +
    `FROM ${d.name} WHERE ${users[0].name} = '${me}'`)
    .then((r) => hourCands.map((f, i) => r.records[0]?.['c' + i] ?? -1), () => null);
  const hours = byCount(hourCands, hourCounts, TIME_HOURS_DEFAULT).slice(0, 8);
  const role = d.fields.find((f) => f.name === 'Role__c') || d.fields.find((f) => /^role$/i.test(f.label));
  // "Owner ID" reads better as "Owner".
  const info = (f) => ({ name: f.name, label: f.type === 'reference' ? f.label.replace(/\s+ID$/, '') : f.label, type: f.type, count: f.count ?? null });

  const meta = {
    object: d.name,
    label: d.label,
    labelPlural: pluralLabel(d),
    oppField: ds.oppField,
    oppRel: opp?.relationshipName || null,
    roleField: role?.name || null,
    dateFields: dates.length ? dates.map(info) : [{ name: 'CreatedDate', label: 'Created Date', type: 'datetime' }],
    hoursFields: hours.map((f) => ({ ...info(f), unit: timeUnit(f) })),
    userFields: users.map((f) => ({ ...info(f), rel: f.relationshipName || null })),
  };
  req.session.timeMeta = meta;
  return meta;
}

// Every Deal Support where the chosen user field is me, across all opportunities, newest first.
// The page does the totals by week, period and opportunity.
api.get('/my-time', wrap(async (req, res) => {
  const userId = sfId(req.session.sf.user.id);
  // Saved per user field, so the last copy can be shown when Salesforce can't be reached.
  const kind = 'myTime:' + String(req.query.by || 'default').slice(0, 80);
  res.json(await withCacheFallback(req, res, async () => {
    const tm = await timeMeta(req);
    const by = tm.userFields.find((f) => f.name === req.query.by) || tm.userFields[0];
    const fields = ['Id', 'Name', ...tm.dateFields.map((f) => f.name), ...tm.hoursFields.map((f) => f.name), tm.oppField,
      ...(tm.oppRel ? [`${tm.oppRel}.Name`, `${tm.oppRel}.AccountId`, `${tm.oppRel}.Account.Name`, `${tm.oppRel}.StageName`] : []),
      ...(tm.roleField ? [tm.roleField] : [])].filter((f, i, all) => all.indexOf(f) === i);
    const records = await query(req, `SELECT ${fields.join(', ')} FROM ${tm.object} ` +
      `WHERE ${by.name} = '${userId}' ORDER BY ${tm.dateFields[0].name} DESC NULLS LAST`, 10000);
    const out = { ...tm, by: by.name, records };
    store.saveSetting(orgOf(req), kind, out);
    return out;
  }, () => {
    const saved = store.getSetting(orgOf(req), kind);
    return saved && { data: saved };
  }));
}));

// ---------- My Calendar ----------

// Your Salesforce calendar (Event records you own; invitees get their own copy) for a date range,
// each marked as covered by a Deal Support or not. An event is covered when a Deal Support was
// created from it here (remembered in the local database), or when one of yours has the same
// activity date and the event's opportunity, the event's account, or the event's subject as its name.
// Outreach can log one meeting twice at the same time (once on the account, once on the opportunity,
// that copy's subject prefixed "[Backstory | ...]"); those are shown as one event.

const EVENT_READ = ['Id', 'Subject', 'AccountId', 'StartDateTime', 'EndDateTime', 'IsAllDayEvent', 'ActivityDate', 'DurationInMinutes',
  'Location', 'Description', 'WhatId', 'What.Name', 'What.Type', 'Who.Name', 'ShowAs'];

// Which Deal Support fields a new one from an event fills in: name, date, duration, details and
// the person (Assigned SE). Picked from the fields on the create form; the person may be set by
// the server even when the layout leaves it off the form.
async function calendarMeta(req) {
  if (req.session.calendarMeta) return req.session.calendarMeta;
  const ds = await dealSupportMeta(req);
  const tm = await timeMeta(req).catch(() => null);
  const d = await sf(req, 'GET', `/services/data/${API}/sobjects/${ds.object}/describe`);
  const desc = new Map(d.fields.map((f) => [f.name, f]));
  const form = ds.fields.filter((f) => f.createable);
  const text = (f) => `${f.label} ${f.name}`;
  const best = (list, score) => list.map((f) => ({ f, s: score(f) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)[0]?.f || null;

  const nameField = form.find((f) => f.name === 'Name') || null;
  const dateField = best(form.filter((f) => f.type === 'date' || f.type === 'datetime'), (f) =>
    f.name === 'Date_of_Sales_Activity__c' ? 10
      : tm?.dateFields[0]?.name === f.name ? 9
      : /activity|meeting|event/i.test(text(f)) && /date/i.test(text(f)) ? 8
      : /date/i.test(text(f)) && f.type === 'date' ? 3 : 0);
  const hoursField = best(form.filter((f) => ['double', 'int', 'picklist', 'string'].includes(f.type)), (f) =>
    f.name === 'Meeting_Duration__c' ? 10
      : /meeting|customer facing/i.test(text(f)) && /duration|time|hour|hrs/i.test(text(f)) ? 8
      : /duration/i.test(text(f)) ? 6 : 0);
  const textareas = form.filter((f) => f.type === 'textarea');
  const descField = best(textareas, (f) =>
    (/description of (the )?request|request description/i.test(f.label) ? 20
      : /description|details?|notes?|summary|agenda|comments?|activity/i.test(text(f)) ? 10 : 1) + Math.min(f.length || 0, 131072) / 131072);

  // The person: the "mine" field from My Time (Assigned SE), if it is a creatable user lookup.
  const userName = tm?.userFields?.find((f) => f.name !== 'OwnerId' && f.name !== 'CreatedById')?.name;
  const userDesc = userName && desc.get(userName);
  const userField = userDesc?.createable && userDesc.referenceTo?.includes('User') ? userName : null;

  // A direct Account lookup on Deal Support, if there is one (else the account comes via the opportunity).
  const acctField = d.fields.filter((f) => f.type === 'reference' && f.referenceTo?.includes('Account'))
    .sort((a, b) => (b.name === 'Account_lookup__c') - (a.name === 'Account_lookup__c'))[0];

  const meta = {
    nameField: nameField && { name: nameField.name, length: nameField.length },
    dateField: dateField && { name: dateField.name, type: dateField.type },
    hoursField: hoursField && { name: hoursField.name, type: hoursField.type, picklist: hoursField.picklist,
      unit: ['double', 'int'].includes(hoursField.type) ? timeUnit(desc.get(hoursField.name) || hoursField) : 'text' },
    descField: descField && { name: descField.name, length: descField.length },
    userField: userField && { name: userField, label: userDesc.label.replace(/\s+ID$/, ''), onForm: form.some((f) => f.name === userField) },
    // Date and person fields used to find my existing Deal Supports for an event.
    matchDate: (dateField || tm?.dateFields[0])?.name || null,
    matchUser: userField || tm?.userFields?.[0]?.name || null,
    matchAccount: acctField?.name || null,
    matchAccountRel: acctField?.relationshipName || null,
  };
  req.session.calendarMeta = meta;
  return meta;
}

const isoDateTime = (v) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s) || isNaN(Date.parse(s))) {
    throw new HttpError(400, 'Invalid date-time (expected ISO format in UTC)');
  }
  return s.replace(/\.\d+Z$/, 'Z');
};
const isoDate = (v) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, 'Invalid date (expected YYYY-MM-DD)');
  return s;
};

// My Deal Supports dated within [d0, d1], for matching events to them, with their accounts' Ids,
// names and websites (events from the Mac's calendar only have a title and attendees to go on).
async function myDealSupportsBetween(req, ds, cm, d0, d1) {
  if (!cm.matchDate) return [];
  const me = sfId(req.session.sf.user.id);
  const tm = await timeMeta(req).catch(() => null);
  const opp = tm?.oppRel;
  const acct = cm.matchAccount && cm.matchAccountRel;
  const hours = tm?.hoursFields[0], activity = activityField(ds);
  const fields = ['Id', 'Name', cm.matchDate, ds.oppField, ...(hours ? [hours.name] : []), ...(activity ? [activity.name] : []),
    ...(opp ? [`${opp}.Name`, `${opp}.AccountId`, `${opp}.Account.Name`, `${opp}.Account.Website`] : []),
    ...(cm.matchAccount ? [cm.matchAccount] : []), ...(acct ? [`${acct}.Name`, `${acct}.Website`] : [])];
  const dateType = cm.dateField?.name === cm.matchDate ? cm.dateField.type : 'date';
  const range = dateType === 'datetime'
    ? `${cm.matchDate} >= ${d0}T00:00:00Z AND ${cm.matchDate} <= ${d1}T23:59:59Z`
    : `${cm.matchDate} >= ${d0} AND ${cm.matchDate} <= ${d1}`;
  const who = [cm.matchUser && `${cm.matchUser} = '${me}'`, `CreatedById = '${me}'`].filter(Boolean);
  const run = (f) => query(req, `SELECT ${[...new Set(f)].join(', ')} FROM ${ds.object} ` +
    `WHERE ${range} AND (${[...new Set(who)].join(' OR ')})`, 2000);
  // Website can be hidden by field security; carry on without it.
  const recs = await run(fields).catch((err) => {
    if (err.status !== 400) throw err;
    return run(fields.filter((f) => !f.endsWith('.Website')));
  });
  return recs.map((r) => {
    const accts = [acct && r[acct], opp && r[opp]?.Account].filter(Boolean);
    return { Id: r.Id, Name: r.Name, date: String(r[cm.matchDate] || '').slice(0, 10),
      oppId: r[ds.oppField] || null, oppName: opp ? r[opp]?.Name || null : null,
      accountIds: [cm.matchAccount && r[cm.matchAccount], opp && r[opp]?.AccountId].filter(Boolean),
      accountNames: accts.map((a) => a.Name).filter(Boolean),
      hours: hours ? r[hours.name] ?? null : null, activity: activity ? String(r[activity.name] ?? '').split(';').join(', ') : '',
      domains: accts.map((a) => domainOf(a.Website)).filter(Boolean) };
  });
}

// Deal Supports by Id (to check the linked ones still exist), with their opportunity.
async function dealSupportsById(req, ds, ids) {
  if (!ids.length) return [];
  const opp = (await timeMeta(req).catch(() => null))?.oppRel;
  const recs = await query(req, `SELECT Id, Name, ${ds.oppField}${opp ? `, ${opp}.Name` : ''} FROM ${ds.object} ` +
    `WHERE Id IN (${ids.map((id) => `'${sfId(id)}'`).join(', ')})`, 500);
  return recs.map((r) => ({ Id: r.Id, Name: r.Name, oppId: r[ds.oppField] || null, oppName: opp ? r[opp]?.Name || null : null }));
}

// The subject without an Outreach "[Backstory | ...]" prefix, for spotting duplicates and naming Deal Supports.
const cleanSubject = (s) => String(s || '').replace(/^\s*\[backstory\b[^\]]*\]\s*/i, '').trim();

// "https://www.kochind.com/about" -> "kochind.com"
function domainOf(url) {
  const host = String(url || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0].replace(/^www\./, '');
  return /\.[a-z]{2,}$/.test(host) ? host : null;
}
// The registrable part of a domain, roughly: "mail.kochind.com" -> "kochind", "bnb.co.uk" -> "bnb".
const domainLabel = (d) => d.split('.').filter((x, i, all) => i < all.length - 1 && !(all.length > 2 && i === all.length - 2 && x.length <= 3)).pop() || d;

// Words too common in account names or meeting titles to tie a meeting to an account.
const NAME_STOP = new Set(['the', 'and', 'inc', 'corp', 'corporation', 'company', 'llc', 'ltd', 'plc', 'group', 'holdings',
  'international', 'industries', 'global', 'services', 'solutions', 'technologies', 'technology', 'systems', 'bank',
  'university', 'health', 'healthcare', 'financial', 'insurance', 'national', 'american', 'united', 'sailpoint',
  'meeting', 'call', 'sync', 'touchpoint', 'demo', 'review', 'monthly', 'weekly', 'strategy', 'identity', 'security']);
const nameWords = (s) => String(s || '').toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean);

// Does a meeting title name this account? The whole name (less "Inc", "Corp"...) as words, or any
// distinctive word of it ("Koch" in "Koch Industries", "B&B" in "B&B Hotels").
function titleNamesAccount(title, account) {
  const t = ` ${nameWords(title).join(' ')} `;
  const words = nameWords(account);
  const core = words.filter((w) => !['inc', 'corp', 'corporation', 'company', 'llc', 'ltd', 'plc', 'the'].includes(w)).join(' ');
  if (core.length >= 2 && t.includes(` ${core} `)) return true;
  return words.some((w) => !NAME_STOP.has(w) && (w.length >= 4 || w.includes('&')) && t.includes(` ${w} `));
}

// Email domains that say nothing about the customer: my company's and free mail.
const NOT_CUSTOMER = new Set(['sailpoint.com', 'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'resource.calendar.google.com']);

// The customer domains among a meeting's attendee emails: not mine, not free mail, not room calendars.
function customerDomains(emails, myDomain) {
  const own = (d) => d === myDomain || NOT_CUSTOMER.has(d) || [...NOT_CUSTOMER].some((x) => d.endsWith('.' + x)) ||
    d.endsWith('.onmicrosoft.com');
  return [...new Set(emails.map((m) => String(m || '').toLowerCase().trim().split('@')[1]).filter((d) => d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && !own(d)))];
}

// Accounts an email domain belongs to: those whose Website is the domain (or its parent, for
// "us.acme.com"), else those with the most Contacts at that domain. Cached for an hour.
const domainAccountCache = new Map(); // `${org}|${domain}` -> { at, accounts }
async function accountsForDomains(req, domains) {
  const org = orgOf(req), out = new Map(), todo = [];
  for (const d of domains.slice(0, 10)) {
    const hit = domainAccountCache.get(`${org}|${d}`);
    if (hit && Date.now() - hit.at < 3600_000) out.set(d, hit.accounts); else todo.push(d);
  }
  if (todo.length) {
    const sites = await query(req, `SELECT Id, Name, Website FROM Account WHERE ` +
      todo.map((d) => `Website LIKE '%${soqlLike(domainLabel(d) + '.')}%'`).join(' OR '), 500).catch(() => []);
    const contacts = await query(req, `SELECT AccountId, Account.Name, Email FROM Contact WHERE AccountId != null AND (` +
      todo.map((d) => `Email LIKE '%@${soqlLike(d)}'`).join(' OR ') + ')', 2000).catch(() => []);
    for (const d of todo) {
      let accounts = sites.filter((a) => { const w = domainOf(a.Website); return w && (d === w || d.endsWith('.' + w)); })
        .map((a) => ({ Id: a.Id, Name: a.Name, how: 'website' }));
      if (!accounts.length) {
        const n = new Map();
        for (const c of contacts) {
          if (String(c.Email || '').toLowerCase().split('@')[1] !== d) continue;
          const a = n.get(c.AccountId) || { Id: c.AccountId, Name: c.Account?.Name || '', how: 'contacts', contacts: 0 };
          a.contacts++;
          n.set(c.AccountId, a);
        }
        const top = Math.max(0, ...[...n.values()].map((a) => a.contacts));
        accounts = [...n.values()].filter((a) => a.contacts * 2 > top).sort((a, b) => b.contacts - a.contacts);
      }
      domainAccountCache.set(`${org}|${d}`, { at: Date.now(), accounts });
      out.set(d, accounts);
    }
  }
  return out;
}

// The local calendar date a Salesforce event falls on, given the page's UTC offset in minutes (from getTimezoneOffset).
function eventDate(e, tzOffset) {
  if (e.IsAllDayEvent) return e.ActivityDate;
  const t = Date.parse(String(e.StartDateTime).replace(/\+0000$/, 'Z')) - tzOffset * 60_000;
  return new Date(t).toISOString().slice(0, 10);
}

// Salesforce Events I own, as calendar events. Copies of one meeting (same start, same subject once
// the Backstory prefix is gone) are collapsed, keeping the opportunity copy.
async function salesforceEvents(req, { from, to, d0, d1, tz }) {
  const me = sfId(req.session.sf.user.id);
  const where = `OwnerId = '${me}' AND IsRecurrence = false AND (` +
    `(IsAllDayEvent = false AND StartDateTime < ${to} AND EndDateTime > ${from}) OR ` +
    `(IsAllDayEvent = true AND ActivityDate >= ${d0} AND ActivityDate <= ${d1}))`;
  const events = await query(req, `SELECT ${EVENT_READ.join(', ')} FROM Event WHERE ${where} ORDER BY StartDateTime ASC`, 1000);
  const norm = (s) => cleanSubject(s).toLowerCase();
  const groups = new Map();
  for (const e of events) {
    const key = `${e.IsAllDayEvent ? e.ActivityDate : e.StartDateTime}|${norm(e.Subject)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const isOpp = (e) => whatType(e) === 'Opportunity';
  const list = [...groups.values()].map((copies) => {
    const e = copies.find(isOpp) || copies[0];
    return {
      id: e.Id, copies: copies.filter((c) => c !== e).map((c) => c.Id), sfEvent: true,
      subject: e.Subject || '(no subject)', title: cleanSubject(e.Subject) || '(no subject)', start: e.StartDateTime, end: e.EndDateTime,
      allDay: !!e.IsAllDayEvent, date: eventDate(e, tz), minutes: e.DurationInMinutes ?? null, location: e.Location || '',
      description: e.Description || '', who: e.Who?.Name || '', showAs: e.ShowAs || '',
      what: e.WhatId ? { id: e.WhatId, name: e.What?.Name || '', type: whatType(e) } : null,
      oppId: isOpp(e) ? e.WhatId : null,
      accountIds: [...new Set(copies.flatMap((c) => [c.AccountId, whatType(c) === 'Account' && c.WhatId]).filter(Boolean))],
      domains: [],
    };
  });
  // Events linked to nothing: their invitees' email domains help find the account.
  const bare = list.filter((e) => !e.what && !e.accountIds.length);
  if (bare.length) {
    const myDomain = String(req.session.sf.user.username || '').split('@')[1]?.toLowerCase();
    const rels = await query(req, `SELECT EventId, Relation.Email FROM EventRelation WHERE EventId IN (` +
      bare.flatMap((e) => [e.id, ...e.copies]).map((id) => `'${sfId(id)}'`).join(', ') + ')', 2000).catch(() => []);
    for (const e of bare) {
      const ids = new Set([e.id, ...e.copies]);
      e.domains = customerDomains(rels.filter((r) => ids.has(r.EventId)).map((r) => r.Relation?.Email), myDomain);
    }
  }
  return list;
}

// Events from one of the Mac's calendars. Attendee domains other than my own help find the account.
async function macEvents(req, calendarId, { from, to }) {
  const myDomain = String(req.session.sf.user.username || '').split('@')[1]?.toLowerCase();
  const events = await macCal.events(from, to, [calendarId]);
  return events.map((e) => {
    const others = (e.attendees || []).filter((a) => !a.me && a.email && !a.email.toLowerCase().endsWith('@' + myDomain));
    return {
      id: e.id, copies: [], sfEvent: false,
      subject: e.title || '(no subject)', title: cleanSubject(e.title) || '(no subject)', start: e.start, end: e.end,
      allDay: !!e.allDay, date: e.date, minutes: null, location: e.location || '',
      description: e.notes || '', who: others.map((a) => a.name || a.email).join(', '), showAs: e.free ? 'Free' : '',
      what: null, oppId: null, accountIds: [], calendar: e.calendar,
      domains: customerDomains(others.map((a) => a.email), myDomain),
    };
  }).sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

// Meetings synced into Salesforce (e.g. by Outreach) carry the account and opportunity. For each Mac
// event, find the Salesforce event at the same start with the same or a similar subject (or the only one
// at that start) and use its links for matching and to preselect the opportunity.
async function borrowSalesforceLinks(req, events, range) {
  const sfEvents = await salesforceEvents(req, range).catch(() => []);
  const simple = (s) => cleanSubject(s).toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
  for (const e of events) {
    const at = Date.parse(e.start);
    const same = sfEvents.filter((x) => x.allDay === e.allDay && (e.allDay ? x.date === e.date : Date.parse(x.start) === at));
    const a = simple(e.subject);
    const hit = same.find((x) => { const b = simple(x.subject); return a && b && (a === b || a.includes(b) || b.includes(a)); }) ||
      (same.length === 1 ? same[0] : null);
    if (!hit) continue;
    e.accountIds = hit.accountIds;
    e.oppId = hit.oppId;
    e.what = hit.what;
    e.sfEventId = hit.id;
  }
}

// The Mac's calendars, for the source picker. Empty when not on a Mac; an error message when access
// was refused, so the page can say so and stay on Salesforce events.
api.get('/calendar/sources', wrap(async (req, res) => {
  if (!macCal) return res.json({ mac: false, calendars: [] });
  try {
    res.json({ mac: true, calendars: await macCal.calendars() });
  } catch (err) {
    res.json({ mac: true, calendars: [], error: err.message });
  }
}));

// Calendar events for a range, each marked as covered by a Deal Support or not. source is
// "salesforce" (default) or a Mac calendar Id. from/to: the range's start and end as UTC instants;
// d0/d1: its first and last local dates.
api.get('/calendar', wrap(async (req, res) => {
  const range = {
    from: isoDateTime(req.query.from), to: isoDateTime(req.query.to),
    d0: isoDate(req.query.d0), d1: isoDate(req.query.d1),
    tz: Math.max(-840, Math.min(840, Number(req.query.tz) || 0)),
  };
  const source = String(req.query.source || 'salesforce').slice(0, 300);
  if (source !== 'salesforce' && !macCal) throw new HttpError(400, 'The Mac calendar is only available when SF Desk runs on a Mac.');
  const kind = `calendar:${source}:${range.d0}:${range.d1}`;
  res.json(await withCacheFallback(req, res, async () => {
    const ds = await dealSupportMeta(req);
    const cm = await calendarMeta(req);
    const events = source === 'salesforce' ? await salesforceEvents(req, range) : await macEvents(req, source, range);
    if (source !== 'salesforce') await borrowSalesforceLinks(req, events, range);

    const marks = store.eventMarks(orgOf(req), events.flatMap((e) => [e.id, ...e.copies]));
    const linkedIds = [...new Set(Object.values(marks).map((m) => m.dsId).filter(Boolean))];
    const [linked, mine] = await Promise.all([dealSupportsById(req, ds, linkedIds), myDealSupportsBetween(req, ds, cm, range.d0, range.d1)]);
    const linkedById = new Map(linked.map((r) => [r.Id, r]));

    // Covered: a Deal Support created from the event (or a copy of it), or one of mine on the same date
    // with the event's opportunity, the event's account, or the event's title as its name. Mac events
    // have no Salesforce links, so for those the account is found from the title and attendee domains.
    const out = events.map((e) => {
      const { oppId, ...shown } = e;
      return { ...shown, supports: coveringSupports(e, marks, linkedById, mine), skipped: [e.id, ...e.copies].some((id) => marks[id]?.skipped) };
    });
    // My Deal Supports dated this week, for the list under the calendar, with the events each covers.
    const tm = await timeMeta(req).catch(() => null);
    const hoursF = tm?.hoursFields[0];
    const week = mine.map((r) => ({ Id: r.Id, Name: r.Name, date: r.date, activity: r.activity, hours: r.hours,
      oppName: r.oppName, accountName: r.accountNames[0] || '', events: out.filter((e) => e.supports.some((x) => x.Id === r.Id)).map((e) => e.id) }))
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.Name).localeCompare(String(b.Name)));
    const data = { source, events: out, prefill: cm, week, weekHours: hoursF ? { label: hoursF.label, unit: hoursF.unit } : null,
      activityLabel: activityField(ds)?.label || null, dealSupport: { object: ds.object, label: ds.label, labelPlural: ds.labelPlural } };
    store.saveSetting(orgOf(req), kind, data);
    return data;
  }, () => {
    const saved = store.getSetting(orgOf(req), kind);
    return saved && { data: saved };
  }));
}));

// The Deal Supports covering an event: those created from it (or a copy of it) here, then mine on the same
// date with the event's opportunity, account or title as their name. Events from outside Salesforce have no
// links of their own unless borrowed, so for those the account is also found from the title and attendee domains.
function coveringSupports(e, marks, linkedById, mine) {
  const norm = (s) => cleanSubject(s).toLowerCase();
  const supports = [];
  for (const id of [e.id, ...e.copies]) {
    const m = marks[id];
    if (m?.dsId && linkedById.has(m.dsId) && !supports.some((x) => x.Id === m.dsId)) supports.push({ ...linkedById.get(m.dsId), how: 'created' });
  }
  for (const r of mine) {
    if (r.date !== e.date || supports.some((x) => x.Id === r.Id)) continue;
    const hit = (e.oppId && r.oppId === e.oppId) || norm(r.Name) === norm(e.subject) ||
      r.accountIds.some((a) => e.accountIds.includes(a)) ||
      (!e.sfEvent && (r.accountNames.some((n) => titleNamesAccount(e.title, n)) ||
        r.domains.some((d) => e.domains.some((x) => x === d || x.endsWith('.' + d) || domainLabel(x) === domainLabel(d)))));
    if (hit) supports.push({ ...r, how: 'matched' });
  }
  return supports;
}

// Event Ids: Salesforce Ids, or "mac_" (Mac calendar) or "ol_" (Outlook add-in) plus a hash.
function eventId(value) {
  const id = String(value || '');
  if (/^(mac|ol)_[0-9a-f]{24}$/.test(id)) return id;
  return sfId(id);
}

// The meeting open in Outlook (sent by the add-in's task pane), as a calendar event like the Time Entry
// tab's, with the account and opportunity of the Salesforce copy at the same time (e.g. synced by
// Outreach), the Deal Supports already covering it and what the create form prefills.
api.post('/outlook/event', wrap(async (req, res) => {
  const b = req.body || {};
  const str = (v, max) => String(v ?? '').slice(0, max);
  const start = isoDateTime(b.start), end = isoDateTime(b.end);
  const tz = Math.max(-840, Math.min(840, Number(b.tz) || 0));
  const subject = str(b.subject, 255);
  const date = b.allDay ? isoDate(b.date) : new Date(Date.parse(start) - tz * 60_000).toISOString().slice(0, 10);
  const myDomain = String(req.session.sf.user.username || '').split('@')[1]?.toLowerCase();
  const attendees = (Array.isArray(b.attendees) ? b.attendees : []).slice(0, 200)
    .map((a) => ({ name: str(a?.name, 120), email: str(a?.email, 254).toLowerCase() }));
  const others = attendees.filter((a) => a.email && !a.email.endsWith('@' + myDomain));
  const e = {
    id: 'ol_' + crypto.createHash('sha1').update(str(b.itemId, 1000) || `${subject}|${start}`).digest('hex').slice(0, 24),
    copies: [], sfEvent: false,
    subject: subject || '(no subject)', title: cleanSubject(subject) || '(no subject)', start, end,
    allDay: !!b.allDay, date, minutes: null, location: str(b.location, 255),
    description: str(b.body, 32000), who: others.map((a) => a.name || a.email).join(', '), showAs: '',
    what: null, oppId: null, accountIds: [], domains: customerDomains(others.map((a) => a.email), myDomain),
  };
  const ds = await dealSupportMeta(req);
  const cm = await calendarMeta(req);
  const to = Date.parse(end) > Date.parse(start) ? end : new Date(Date.parse(start) + 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  await borrowSalesforceLinks(req, [e], { from: start, to, d0: date, d1: date, tz });
  const marks = store.eventMarks(orgOf(req), [e.id]);
  const linkedIds = [...new Set(Object.values(marks).map((m) => m.dsId).filter(Boolean))];
  const [linked, mine] = await Promise.all([dealSupportsById(req, ds, linkedIds),
    myDealSupportsBetween(req, ds, cm, date, date)]);
  const supports = coveringSupports(e, marks, new Map(linked.map((r) => [r.Id, r])), mine);
  res.json({ event: { ...e, supports, skipped: !!marks[e.id]?.skipped }, prefill: cm,
    dealSupport: { object: ds.object, label: ds.label, labelPlural: ds.labelPlural } });
}));

// Create a Deal Support from an event, on the opportunity the page picked, and remember the link.
api.post('/calendar/events/:id/deal-support', wrap(async (req, res) => {
  const evId = eventId(req.params.id);
  const oppId = sfId(req.body?.opportunityId);
  const me = sfId(req.session.sf.user.id);
  if (!/^(mac|ol)_/.test(evId)) {
    const [ev] = await query(req, `SELECT Id FROM Event WHERE Id = '${evId}' AND OwnerId = '${me}'`);
    if (!ev) throw new HttpError(404, 'That event is not on your calendar.');
  }
  const ds = await dealSupportMeta(req);
  const cm = await calendarMeta(req);
  const extra = cm.userField && !cm.userField.onForm ? { [cm.userField.name]: me } : {};
  const rec = await createDealSupport(req, ds, oppId, req.body?.fields, extra);
  store.linkEvent(orgOf(req), evId, rec.Id);
  res.status(201).json(rec);
}));

// Mark an event as needing no Deal Support (skip: true), or undo that.
api.post('/calendar/events/:id/skip', (req, res) => {
  // copies: the other records of the same meeting the page shows as one event.
  const copies = Array.isArray(req.body?.copies) ? req.body.copies.slice(0, 20) : [];
  for (const id of [req.params.id, ...copies]) store.skipEvent(orgOf(req), eventId(id), !!req.body?.skip);
  res.json({ ok: true });
});

// ---------- Open opportunities (Deal Support picker) ----------

// Every open opportunity you can see, kept in the local database and refreshed from Salesforce
// when older than OPEN_OPPS_MAX_AGE (or on refresh=1). Type-ahead searches run on this copy.
const OPEN_OPPS_MAX_AGE = 4 * 3600_000;
const openOpps = new Map(); // org Id -> { at, records }

async function openOpportunities(req, refresh) {
  const org = orgOf(req);
  let cached = openOpps.get(org) || store.getSetting(org, 'openOpps');
  if (cached && !openOpps.has(org)) openOpps.set(org, cached);
  if (cached && !refresh && Date.now() - Date.parse(cached.at) < OPEN_OPPS_MAX_AGE) return cached;
  try {
    const recs = await query(req, 'SELECT Id, Name, AccountId, Account.Name, StageName, CloseDate, Owner.Name ' +
      'FROM Opportunity WHERE IsClosed = false ORDER BY Name ASC', 50000);
    cached = {
      at: new Date().toISOString(),
      records: recs.map((o) => ({ Id: o.Id, Name: o.Name, AccountId: o.AccountId, Account: { Name: o.Account?.Name || '' },
        StageName: o.StageName, CloseDate: o.CloseDate, Owner: { Name: o.Owner?.Name || '' } })),
    };
    store.saveSetting(org, 'openOpps', cached);
    openOpps.set(org, cached);
  } catch (err) {
    if (!(err.status >= 502) || !cached) throw err; // offline: keep using the saved copy
  }
  return cached;
}

// Type-ahead over the open opportunities: every word typed must appear in the opportunity or account
// name. Sorted by name; opportunities on the accounts in `accounts` (Ids) or named in `title` come first.
api.get('/opportunities/open', wrap(async (req, res) => {
  const { at, records } = await openOpportunities(req, req.query.refresh === '1');
  const words = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const accounts = new Set(String(req.query.accounts || '').split(',').filter(Boolean));
  const title = String(req.query.title || '').slice(0, 300);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const matches = words.length
    ? records.filter((o) => { const t = `${o.Name} ${o.Account.Name}`.toLowerCase(); return words.every((w) => t.includes(w)); })
    : records;
  const hinted = (o) => accounts.has(o.AccountId) || (title && o.Account.Name && titleNamesAccount(title, o.Account.Name));
  // When neither the event's links nor its title point to an account, its attendees' email domains
  // (domains: customer ones only) are matched to accounts by website or contacts.
  const domains = String(req.query.domains || '').toLowerCase().split(',').filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)).slice(0, 10);
  let byDomain = [];
  if (domains.length && !records.some(hinted)) {
    const found = await accountsForDomains(req, domains);
    byDomain = [...new Map([...found].flatMap(([d, list]) => list.map((a) => [a.Id, { ...a, domain: d }]))).values()];
  }
  const domainIds = new Set(byDomain.map((a) => a.Id));
  const suggested = (o) => hinted(o) || domainIds.has(o.AccountId);
  const top = (accounts.size || title || domainIds.size) ? [...matches.filter(suggested), ...matches.filter((o) => !suggested(o))] : matches;
  // One open opportunity across the matched accounts: the page can preselect it.
  const onDomain = records.filter((o) => domainIds.has(o.AccountId));
  res.json({ total: records.length, matched: matches.length, syncedAt: at,
    domainAccounts: byDomain.length ? byDomain : undefined, pick: onDomain.length === 1 ? onDomain[0] : undefined,
    records: top.slice(0, limit).map((o) => ({ ...o, suggested: !!suggested(o) || undefined,
      via: !hinted(o) && domainIds.has(o.AccountId) ? 'domain' : undefined })) });
}));

// The activity done on a Deal Support: Requested Activity in Kerry's org, else a field labelled like it.
const activityField = (ds) => ds.fields.find((f) => f.name === 'Requested_SaaS_Activity__c') ||
  ds.fields.find((f) => /^(requested )?activity( type)?$/i.test(f.label.trim()) && f.type !== 'date' && f.type !== 'datetime');

// Deal Supports on an account and all its opportunities (everyone's, not just mine) dated on or after
// `since`, newest first, for the account screen. Uses My Time's date, hours and person fields.
api.get('/accounts/:id/deal-supports', wrap(async (req, res) => {
  const id = sfId(req.params.id);
  const since = isoDate(req.query.since);
  const ds = await dealSupportMeta(req);
  const tm = await timeMeta(req);
  const cm = await calendarMeta(req).catch(() => ({}));
  const date = tm.dateFields[0], hours = tm.hoursFields[0], who = tm.userFields.find((f) => f.rel) || null;
  const activity = activityField(ds);
  const onAccount = [cm.matchAccount && `${cm.matchAccount} = '${id}'`, tm.oppRel && `${tm.oppRel}.AccountId = '${id}'`].filter(Boolean);
  if (!onAccount.length) throw new HttpError(404, `Can't tell which ${ds.labelPlural} belong to an account.`);
  const fields = ['Id', 'Name', date.name, hours.name, ds.oppField, ...(tm.oppRel ? [`${tm.oppRel}.Name`] : []),
    ...(who ? [`${who.rel}.Name`] : []), ...(tm.roleField ? [tm.roleField] : []), ...(activity ? [activity.name] : [])];
  const from = date.type === 'datetime' ? `${since}T00:00:00Z` : since;
  const recs = await query(req, `SELECT ${[...new Set(fields)].join(', ')} FROM ${ds.object} ` +
    `WHERE (${onAccount.join(' OR ')}) AND ${date.name} >= ${from} ORDER BY ${date.name} DESC`, 5000);
  res.json({
    label: ds.label, labelPlural: ds.labelPlural, dateLabel: date.label, hoursLabel: hours.label, hoursUnit: hours.unit,
    whoLabel: who?.label || null, activityLabel: activity?.label || null,
    records: recs.map((r) => ({ Id: r.Id, Name: r.Name, date: String(r[date.name] || '').slice(0, 10), hours: r[hours.name] ?? null,
      oppId: r[ds.oppField] || null, oppName: tm.oppRel ? r[tm.oppRel]?.Name || '' : '', who: who ? r[who.rel]?.Name || '' : '',
      role: tm.roleField ? r[tm.roleField] || '' : '',
      activity: activity ? String(r[activity.name] ?? '').split(';').join(', ') : '' })),
  });
}));

// Hidden records: local to this machine, never written to Salesforce. The page filters its
// lists with these ids and can show them again with "Show hidden".
api.get('/hidden', (req, res) => res.json(store.listHidden(orgOf(req))));

// The Accounts tab's filters (My Accounts, SailPoint BOAT, SE, sales rep, sort, grouping), kept in the
// local database so they come back when SF Desk restarts.
const ACCT_PREF_KEYS = { mine: 'boolean', boat: 'string', se: 'string', rep: 'string', repName: 'string',
  sortRecent: 'boolean', groupByRep: 'boolean', showHidden: 'boolean' };
api.get('/prefs/accounts', (req, res) => res.json(store.getSetting(orgOf(req), 'acctPrefs') || {}));
api.put('/prefs/accounts', (req, res) => {
  const prefs = {};
  for (const [k, type] of Object.entries(ACCT_PREF_KEYS)) {
    const v = req.body?.[k];
    if (typeof v === type) prefs[k] = type === 'string' ? v.slice(0, 255) : v;
  }
  store.saveSetting(orgOf(req), 'acctPrefs', prefs);
  res.json(prefs);
});

function hiddenIds(body) {
  const ids = Array.isArray(body?.ids) ? body.ids : [];
  if (!ids.length || ids.length > 500) throw new HttpError(400, 'Pick between 1 and 500 records');
  return ids.map(sfId);
}

api.post('/hidden', (req, res) => {
  const type = req.body?.type;
  if (type !== 'Account' && type !== 'Opportunity') throw new HttpError(400, 'type must be Account or Opportunity');
  const ids = hiddenIds(req.body);
  const names = req.body.names || {};
  store.hide(orgOf(req), type, ids.map((id) => ({ id, name: typeof names[id] === 'string' ? names[id].slice(0, 255) : null })));
  res.json(store.listHidden(orgOf(req)));
});

api.post('/hidden/remove', (req, res) => {
  store.unhide(orgOf(req), hiddenIds(req.body));
  res.json(store.listHidden(orgOf(req)));
});

app.use('/api', api);

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = status === 500 ? 'Unexpected server error (see terminal)' : err.message;
  if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).type('text').send(message);
});

// Started by the Mac app (mac/app): stop when it quits or dies, which closes our stdin.
if (process.env.SF_DESK_APP) process.stdin.on('end', () => process.exit(0)).on('error', () => process.exit(0)).resume();

app.listen(PORT, 'localhost', () => {
  console.log(`SF Desk running at http://localhost:${PORT}`);
  if (USE_CLI) console.log(`No SF_CLIENT_ID set: signing in with the Salesforce CLI login${SF_TARGET_ORG ? ` for "${SF_TARGET_ORG}"` : ' (default org)'}.`);
});

// HTTPS for the Outlook add-in, only when its certificate has been made (scripts/outlook-cert.sh).
const certFile = path.join(CERT_DIR, 'localhost.pem'), keyFile = path.join(CERT_DIR, 'localhost-key.pem');
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app)
    .on('error', (err) => console.error(`Outlook add-in HTTPS listener not started: ${err.message}`))
    .listen(HTTPS_PORT, 'localhost', () => console.log(`Outlook add-in served at https://localhost:${HTTPS_PORT}/outlook/pane`));
}
