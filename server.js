// SF Desk — local Salesforce account & opportunity editor.
// Talks to the Salesforce REST API using your own OAuth login (PKCE).
// Runs on localhost only; tokens live in server memory for the session.

import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const LOGIN_URL = (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').replace(/\/$/, '');
const API = process.env.SF_API_VERSION || 'v62.0';
const CLIENT_ID = process.env.SF_CLIENT_ID;
const CLIENT_SECRET = process.env.SF_CLIENT_SECRET || '';
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;

if (!CLIENT_ID) {
  console.error('Missing SF_CLIENT_ID in .env. See README.md for setup.');
  process.exit(1);
}

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

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- OAuth (Web Server flow + PKCE) ----------

app.get('/login', (req, res) => {
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
  const me = await sf(req, 'GET', '/services/oauth2/userinfo');
  req.session.sf.user = { id: me.user_id, name: me.name, username: me.preferred_username };
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
  const r = await fetch(t.instance_url + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${t.access_token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (r.status === 401 && !retried && t.refresh_token) {
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

// Find the Lead SE field on an object: by API name if configured, else by its label.
function findLeadSe(describe) {
  const f = describe.fields.find((x) => LEAD_SE_FIELD
    ? x.name.toLowerCase() === LEAD_SE_FIELD.toLowerCase()
    : /^lead\s*se$/i.test(x.label.trim()));
  return f ? { name: f.name, isUser: f.type === 'reference' } : null;
}

async function leadSeFields(req) {
  if (!req.session.leadSe) {
    const describe = (o) => sf(req, 'GET', `/services/data/${API}/sobjects/${o}/describe`);
    const [acct, opp] = await Promise.all([describe('Account'), describe('Opportunity')]);
    req.session.leadSe = { Account: findLeadSe(acct), Opportunity: findLeadSe(opp) };
  }
  const fields = req.session.leadSe;
  if (!fields.Account && !fields.Opportunity) {
    throw new HttpError(400, 'No "Lead SE" field found on Account or Opportunity. ' +
      'Set SF_LEAD_SE_FIELD in .env to its API name (e.g. Lead_SE__c) and restart.');
  }
  return fields;
}

// SOQL condition matching the signed-in user: by User Id for a lookup field, else by full name.
function leadSeIsMe(req, field) {
  const user = req.session.sf.user;
  return field.isUser
    ? `${field.name} = '${sfId(user.id)}'`
    : `${field.name} = '${String(user.name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
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
  if (t?.refresh_token || t?.access_token) {
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
  if (!req.session.meta) {
    const describe = (o) => sf(req, 'GET', `/services/data/${API}/sobjects/${o}/describe`);
    const [acct, opp] = await Promise.all([describe('Account'), describe('Opportunity')]);
    const picklist = (d, name) =>
      (d.fields.find((f) => f.name === name)?.picklistValues || []).filter((v) => v.active).map((v) => v.value);
    const editable = (d, names) =>
      d.fields.filter((f) => names.includes(f.name) && f.updateable).map((f) => f.name);
    const creatable = (d, names) =>
      d.fields.filter((f) => names.includes(f.name) && f.createable).map((f) => f.name);
    req.session.meta = {
      picklists: {
        Type: picklist(acct, 'Type'),
        Industry: picklist(acct, 'Industry'),
        StageName: picklist(opp, 'StageName'),
      },
      editable: { Account: editable(acct, ACCOUNT_FIELDS), Opportunity: editable(opp, OPP_FIELDS) },
      canCreateOpportunity: opp.createable && creatable(opp, ['Name', 'StageName', 'CloseDate']).length === 3,
    };
  }
  res.json(req.session.meta);
}));

api.get('/accounts', wrap(async (req, res) => {
  const where = [];
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) where.push(`Name LIKE '%${soqlLike(q)}%'`);
  const soql = (extra = []) => {
    const w = [...where, ...extra];
    return 'SELECT Id, Name, Type, Industry, BillingCity, BillingState, Owner.Name, LastModifiedDate ' +
      `FROM Account ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY LastModifiedDate DESC LIMIT 200`;
  };
  if (req.query.leadse !== '1') return res.json(await query(req, soql()));

  // An account is "mine" if I'm its Lead SE, or Lead SE on any of its opportunities.
  // SOQL can't OR a sub-select, so run one query per field and merge.
  const lse = await leadSeFields(req);
  const queries = [];
  if (lse.Account) queries.push(query(req, soql([leadSeIsMe(req, lse.Account)])));
  if (lse.Opportunity) {
    queries.push(query(req, soql([`Id IN (SELECT AccountId FROM Opportunity WHERE ${leadSeIsMe(req, lse.Opportunity)})`])));
  }
  const byId = new Map();
  for (const rec of (await Promise.all(queries)).flat()) byId.set(rec.Id, rec);
  res.json([...byId.values()]
    .sort((a, b) => String(b.LastModifiedDate).localeCompare(String(a.LastModifiedDate)))
    .slice(0, 200));
}));

api.get('/accounts/:id', wrap(async (req, res) => {
  const id = sfId(req.params.id);
  const [account] = await query(req, `SELECT ${ACCOUNT_READ.join(', ')} FROM Account WHERE Id = '${id}'`);
  if (!account) throw new HttpError(404, 'Account not found');
  const where = [`AccountId = '${id}'`];
  if (req.query.leadse === '1') {
    const lse = await leadSeFields(req);
    if (lse.Opportunity) where.push(leadSeIsMe(req, lse.Opportunity));
  }
  const opportunities = await query(req,
    `SELECT ${OPP_READ.join(', ')} FROM Opportunity WHERE ${where.join(' AND ')} ORDER BY IsClosed ASC, CloseDate ASC`);
  res.json({ account, opportunities });
}));

api.patch('/accounts/:id', wrap(async (req, res) => {
  res.json(await updateRecord(req, 'Account', ACCOUNT_FIELDS, ACCOUNT_READ));
}));

api.patch('/opportunities/:id', wrap(async (req, res) => {
  res.json(await updateRecord(req, 'Opportunity', OPP_FIELDS, OPP_READ));
}));

api.post('/opportunities', wrap(async (req, res) => {
  const fields = req.body?.fields || {};
  const body = { AccountId: sfId(fields.AccountId) };
  for (const k of OPP_FIELDS) if (fields[k] !== undefined && fields[k] !== '' && fields[k] !== null) body[k] = fields[k];
  for (const k of ['Name', 'StageName', 'CloseDate']) if (!body[k]) throw new HttpError(400, `${k} is required`);
  const created = await sf(req, 'POST', `/services/data/${API}/sobjects/Opportunity`, { body });
  const [rec] = await query(req, `SELECT ${OPP_READ.join(', ')} FROM Opportunity WHERE Id = '${sfId(created.id)}'`);
  res.status(201).json(rec);
}));

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
});
