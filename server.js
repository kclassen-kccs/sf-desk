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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
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
const ACCOUNT_READ = ['Id', ...ACCOUNT_FIELDS, 'Owner.Name', 'LastModifiedDate'];
const OPP_READ = ['Id', 'AccountId', ...OPP_FIELDS, 'IsClosed', 'Owner.Name', 'LastModifiedDate'];

// The "Lead SE" field used for the "only where I'm Lead SE" filter. Set SF_LEAD_SE_FIELD to its API
// name (e.g. Lead_SE__c) if auto-detection by its label "Lead SE" doesn't find it.
const LEAD_SE_FIELD = process.env.SF_LEAD_SE_FIELD || '';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const b64url = (buf) => buf.toString('base64url');

const store = openDb(DB_FILE);

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Salesforce CLI login ----------

// Run an sf CLI command with --json and return its parsed output (errors become HttpErrors).
function runCli(args) {
  const target = SF_TARGET_ORG ? ['--target-org', SF_TARGET_ORG] : [];
  return new Promise((resolve, reject) => {
    execFile(SF_CLI, [...args, '--json', ...target], { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
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
  res.redirect('/');
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
  if (rest.Owner) rest.Owner = { Name: rest.Owner.Name };
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

// ---------- JSON API used by the page ----------

const api = express.Router();

// Simple CSRF guard: writes must carry a custom header, which other sites can't send cross-origin.
api.use((req, res, next) => {
  if (req.method !== 'GET' && req.get('X-SFDesk') !== '1') return next(new HttpError(403, 'Missing request header'));
  next();
});

api.get('/me', (req, res) => {
  const t = req.session.sf;
  res.json(t ? { connected: true, user: t.user, instanceUrl: t.instance_url } : { connected: false });
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
  // Read the Lead SE fields too, so the saved copy can apply the same filter offline.
  const lse = req.query.leadse === '1' ? await leadSeFields(req) : null;
  const fields = withField(['Id', 'Name', 'Type', 'Industry', 'BillingCity', 'BillingState', 'Owner.Name', 'LastModifiedDate'],
    (await knownLeadSeFields(req)).Account);
  const soql = (extra = []) => {
    const w = [...where, ...extra];
    return `SELECT ${fields.join(', ')} ` +
      `FROM Account ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY LastModifiedDate DESC LIMIT 200`;
  };

  res.json(await withCacheFallback(req, res, async () => {
    let accounts;
    if (!lse) {
      accounts = await query(req, soql());
    } else {
      // An account is "mine" if I'm its Lead SE, or Lead SE on any of its opportunities.
      // SOQL can't OR a sub-select, so run one query per field and merge.
      const queries = [];
      if (lse.Account) queries.push(query(req, soql([leadSeIsMe(req, lse.Account)])));
      if (lse.Opportunity) {
        queries.push(query(req, soql([`Id IN (SELECT AccountId FROM Opportunity WHERE ${leadSeIsMe(req, lse.Opportunity)})`])));
      }
      const byId = new Map();
      for (const rec of (await Promise.all(queries)).flat()) byId.set(rec.Id, rec);
      accounts = [...byId.values()]
        .sort((a, b) => String(b.LastModifiedDate).localeCompare(String(a.LastModifiedDate)))
        .slice(0, 200);
    }
    store.saveAccounts(orgOf(req), accounts);
    return accounts;
  }, () => {
    const side = (f) => f && { field: f.name, value: leadSeValue(req, f) };
    const saved = store.listAccounts(orgOf(req), {
      q,
      leadSe: lse && { account: side(lse.Account), opportunity: side(lse.Opportunity) },
    });
    return { data: saved.records, syncedAt: saved.syncedAt };
  }));
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
    const [account] = await query(req, `SELECT ${accountRead(known).join(', ')} FROM Account WHERE Id = '${id}'`);
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
  const rec = await updateRecord(req, 'Account', ACCOUNT_FIELDS, accountRead(await knownLeadSeFields(req)));
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

// Hidden records: local to this machine, never written to Salesforce. The page filters its
// lists with these ids and can show them again with "Show hidden".
api.get('/hidden', (req, res) => res.json(store.listHidden(orgOf(req))));

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

app.listen(PORT, 'localhost', () => {
  console.log(`SF Desk running at http://localhost:${PORT}`);
  if (USE_CLI) console.log(`No SF_CLIENT_ID set: signing in with the Salesforce CLI login${SF_TARGET_ORG ? ` for "${SF_TARGET_ORG}"` : ' (default org)'}.`);
});
