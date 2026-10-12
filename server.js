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
import { isMac, macCalendar } from './macCalendar.js';

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

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const b64url = (buf) => buf.toString('base64url');

const store = openDb(DB_FILE);
const macCal = isMac ? macCalendar(__dirname, path.dirname(DB_FILE)) : null;

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
  // Sales rep filter: the account owner.
  const owner = req.query.owner ? sfId(req.query.owner) : '';
  if (owner) where.push(`OwnerId = '${owner}'`);
  // A–Z by name unless sort=recent asks for most recently modified first.
  const recent = req.query.sort === 'recent';
  // Read the Lead SE fields too, so the saved copy can apply the same filter offline.
  const lse = req.query.leadse === '1' ? await leadSeFields(req) : null;
  const fields = withField(['Id', 'Name', 'Type', 'Industry', 'BillingCity', 'BillingState', 'OwnerId', 'Owner.Name', 'LastModifiedDate'],
    (await knownLeadSeFields(req)).Account);
  const soql = (extra = []) => {
    const w = [...where, ...extra];
    return `SELECT ${fields.join(', ')} ` +
      `FROM Account ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${recent ? 'LastModifiedDate DESC' : 'Name ASC'} LIMIT 200`;
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
        .sort(recent
          ? (a, b) => String(b.LastModifiedDate).localeCompare(String(a.LastModifiedDate))
          : (a, b) => String(a.Name).localeCompare(String(b.Name)))
        .slice(0, 200);
    }
    store.saveAccounts(orgOf(req), accounts);
    return accounts;
  }, () => {
    const side = (f) => f && { field: f.name, value: leadSeValue(req, f) };
    const saved = store.listAccounts(orgOf(req), {
      q,
      ownerId: owner,
      recent,
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

// ---------- Deal Support ----------

// Find the Deal Support object, its lookup to Opportunity, and the fields the form can show.
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
  const fields = picked
    .filter(({ f }, i, all) => f && f.name !== opp.name && DS_TYPES.has(f.type) &&
      all.findIndex((x) => x.f === f) === i)
    .map(({ f, required, onForm = true }) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      createable: f.createable && onForm,
      required: f.createable && onForm && f.type !== 'boolean' && (!f.nillable && !f.defaultedOnCreate ||
        (!!required && !DEAL_SUPPORT_OPTIONAL.includes(f.name.toLowerCase()) && !optionalByLabel.test(f.label))),
      length: f.length || null,
      referenceTo: f.referenceTo?.length ? f.referenceTo : null,
      picklist: f.picklistValues?.length ? f.picklistValues.filter((v) => v.active).map((v) => v.value) : null,
      defaultValue: f.defaultValue ?? null,
    }));
  // New Deal Supports default Role to "Lead SE" (matched ignoring case) when the picklist has it.
  const role = fields.find((f) => f.picklist && (f.name === 'Role__c' || /^role$/i.test(f.label)));
  const leadSe = role?.picklist.find((v) => v.trim().toLowerCase() === 'lead se');
  if (leadSe) role.defaultValue = leadSe;
  const meta = {
    object: d.name,
    label: d.label,
    labelPlural: d.labelPlural,
    oppField: opp.name,
    roleDefault: role ? { field: role.name, value: leadSe || null, options: role.picklist } : null,
    canCreate: d.createable && opp.createable,
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

// ---------- Pipeline dashboard ----------

// Every open opportunity in the Lead SE view (or all you can see with leadse=0), for the dashboard.
// Matches the account view: where I'm Lead SE on the opportunity, or, if only Account has a Lead SE
// field, on its account. The page leaves out hidden records and does the totals.
const PIPELINE_READ = ['Id', 'Name', 'AccountId', 'Account.Name', 'StageName', 'Amount', 'CloseDate', 'Probability',
  'ForecastCategoryName', 'IsClosed', 'Owner.Name', 'LastModifiedDate'];

api.get('/pipeline', wrap(async (req, res) => {
  const known = await knownLeadSeFields(req);
  const lse = req.query.leadse === '1' ? await leadSeFields(req) : null;
  const where = ['IsClosed = false'];
  if (lse?.Opportunity) where.push(leadSeIsMe(req, lse.Opportunity));
  else if (lse?.Account) where.push(leadSeIsMe(req, { ...lse.Account, name: 'Account.' + lse.Account.name }));
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
    return { opportunities, leadSeFiltered: !!lse };
  }, () => {
    const side = (f) => f && { field: f.name, value: leadSeValue(req, f) };
    const saved = store.listOpenOpportunities(orgOf(req), lse && { account: side(lse.Account), opportunity: side(lse.Opportunity) });
    return { data: { opportunities: saved.records, leadSeFiltered: !!lse }, syncedAt: saved.syncedAt };
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
    labelPlural: d.labelPlural,
    oppField: ds.oppField,
    oppRel: opp?.relationshipName || null,
    roleField: role?.name || null,
    dateFields: dates.length ? dates.map(info) : [{ name: 'CreatedDate', label: 'Created Date', type: 'datetime' }],
    hoursFields: hours.map((f) => ({ ...info(f), unit: timeUnit(f) })),
    userFields: users.map(info),
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
  const descField = best(form.filter((f) => f.type === 'textarea'), (f) =>
    (/description|details?|notes?|summary|agenda|comments?|activity/i.test(text(f)) ? 10 : 1) + Math.min(f.length || 0, 131072) / 131072);
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
  const opp = (await timeMeta(req).catch(() => null))?.oppRel;
  const acct = cm.matchAccount && cm.matchAccountRel;
  const fields = ['Id', 'Name', cm.matchDate, ds.oppField,
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
  const isOpp = (e) => e.What?.Type === 'Opportunity';
  return [...groups.values()].map((copies) => {
    const e = copies.find(isOpp) || copies[0];
    return {
      id: e.Id, copies: copies.filter((c) => c !== e).map((c) => c.Id), sfEvent: true,
      subject: e.Subject || '(no subject)', title: cleanSubject(e.Subject) || '(no subject)', start: e.StartDateTime, end: e.EndDateTime,
      allDay: !!e.IsAllDayEvent, date: eventDate(e, tz), minutes: e.DurationInMinutes ?? null, location: e.Location || '',
      description: e.Description || '', who: e.Who?.Name || '', showAs: e.ShowAs || '',
      what: e.WhatId ? { id: e.WhatId, name: e.What?.Name || '', type: e.What?.Type || '' } : null,
      oppId: isOpp(e) ? e.WhatId : null,
      accountIds: [...new Set(copies.flatMap((c) => [c.AccountId, c.What?.Type === 'Account' && c.WhatId]).filter(Boolean))],
      domains: [],
    };
  });
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
      domains: [...new Set(others.map((a) => a.email.split('@')[1]?.toLowerCase()).filter(Boolean))],
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
    const norm = (s) => cleanSubject(s).toLowerCase();

    // Covered: a Deal Support created from the event (or a copy of it), or one of mine on the same date
    // with the event's opportunity, the event's account, or the event's title as its name. Mac events
    // have no Salesforce links, so for those the account is found from the title and attendee domains.
    const out = events.map((e) => {
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
      const { accountIds, oppId, ...shown } = e;
      return { ...shown, supports, skipped: [e.id, ...e.copies].some((id) => marks[id]?.skipped) };
    });
    const data = { source, events: out, prefill: cm, dealSupport: { object: ds.object, label: ds.label, labelPlural: ds.labelPlural } };
    store.saveSetting(orgOf(req), kind, data);
    return data;
  }, () => {
    const saved = store.getSetting(orgOf(req), kind);
    return saved && { data: saved };
  }));
}));

// Event Ids: Salesforce Ids, or "mac_" plus a hash for events from the Mac's calendar.
function eventId(value) {
  const id = String(value || '');
  if (/^mac_[0-9a-f]{24}$/.test(id)) return id;
  return sfId(id);
}

// Create a Deal Support from an event, on the opportunity the page picked, and remember the link.
api.post('/calendar/events/:id/deal-support', wrap(async (req, res) => {
  const evId = eventId(req.params.id);
  const oppId = sfId(req.body?.opportunityId);
  const me = sfId(req.session.sf.user.id);
  if (!evId.startsWith('mac_')) {
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
  const suggested = (o) => accounts.has(o.AccountId) || (title && o.Account.Name && titleNamesAccount(title, o.Account.Name));
  const top = (accounts.size || title) ? [...matches.filter(suggested), ...matches.filter((o) => !suggested(o))] : matches;
  res.json({ total: records.length, matched: matches.length, syncedAt: at,
    records: top.slice(0, limit).map((o) => ({ ...o, suggested: !!suggested(o) || undefined })) });
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
