// Local SQLite copy of the Accounts and Opportunities this app has loaded from Salesforce.
// Every record read from (or written to) Salesforce is saved here, so the app can still show
// what you last saw when Salesforce can't be reached. Salesforce stays the source of truth:
// edits are only ever sent to Salesforce, never queued locally.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Records are keyed by org as well as Id, so connecting to a sandbox and production
  // from the same machine keeps their data apart. `data` holds the full record as JSON;
  // the other columns exist for lookups, search and ordering.
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      org_id        TEXT NOT NULL,
      id            TEXT NOT NULL,
      name          TEXT,
      last_modified TEXT,
      data          TEXT NOT NULL,
      synced_at     TEXT NOT NULL,
      PRIMARY KEY (org_id, id)
    );
    CREATE INDEX IF NOT EXISTS accounts_by_modified ON accounts (org_id, last_modified DESC);

    CREATE TABLE IF NOT EXISTS opportunities (
      org_id        TEXT NOT NULL,
      id            TEXT NOT NULL,
      account_id    TEXT,
      name          TEXT,
      last_modified TEXT,
      data          TEXT NOT NULL,
      synced_at     TEXT NOT NULL,
      PRIMARY KEY (org_id, id)
    );
    CREATE INDEX IF NOT EXISTS opportunities_by_account ON opportunities (org_id, account_id);

    -- Accounts and opportunities you chose to hide from the app's lists. Local only:
    -- nothing about hiding is sent to Salesforce. The name is kept so the record can be
    -- listed for unhiding even if it isn't in the current view.
    CREATE TABLE IF NOT EXISTS hidden_records (
      org_id    TEXT NOT NULL,
      id        TEXT NOT NULL,
      sobject   TEXT NOT NULL,
      name      TEXT,
      hidden_at TEXT NOT NULL,
      PRIMARY KEY (org_id, id)
    );

    -- My Calendar: which Deal Support was created from which calendar event, and events marked as
    -- needing no Deal Support. Local only; nothing here is written to Salesforce.
    CREATE TABLE IF NOT EXISTS event_marks (
      org_id     TEXT NOT NULL,
      event_id   TEXT NOT NULL,
      ds_id      TEXT,
      skipped    INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, event_id)
    );

    -- Per-org settings learned from Salesforce, e.g. kind 'meta' (picklists, editable fields)
    -- and 'leadSe' (which field is the Lead SE field), so the app can start up offline.
    CREATE TABLE IF NOT EXISTS org_settings (
      org_id    TEXT NOT NULL,
      kind      TEXT NOT NULL,
      data      TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (org_id, kind)
    );
  `);

  const now = () => new Date().toISOString();

  const upsertAccount = db.prepare(`
    INSERT INTO accounts (org_id, id, name, last_modified, data, synced_at)
    VALUES (@org_id, @id, @name, @last_modified, @data, @synced_at)
    ON CONFLICT (org_id, id) DO UPDATE SET
      name = excluded.name,
      last_modified = excluded.last_modified,
      data = excluded.data,
      synced_at = excluded.synced_at
  `);
  const getAccountData = db.prepare('SELECT data FROM accounts WHERE org_id = ? AND id = ?');
  const upsertOpp = db.prepare(`
    INSERT INTO opportunities (org_id, id, account_id, name, last_modified, data, synced_at)
    VALUES (@org_id, @id, @account_id, @name, @last_modified, @data, @synced_at)
    ON CONFLICT (org_id, id) DO UPDATE SET
      account_id = excluded.account_id,
      name = excluded.name,
      last_modified = excluded.last_modified,
      data = excluded.data,
      synced_at = excluded.synced_at
  `);
  const oppIdsForAccount = db.prepare('SELECT id FROM opportunities WHERE org_id = ? AND account_id = ?');
  const deleteOpp = db.prepare('DELETE FROM opportunities WHERE org_id = ? AND id = ?');

  // The account list query returns fewer fields than the detail query, so by default a record is
  // merged over the stored copy rather than replacing it; `replace` is for full detail loads.
  const saveAccounts = db.transaction((orgId, recs, { replace = false } = {}) => {
    for (const rec of recs) {
      const prev = replace ? null : getAccountData.get(orgId, rec.Id);
      const merged = prev ? { ...JSON.parse(prev.data), ...rec } : rec;
      upsertAccount.run({
        org_id: orgId,
        id: merged.Id,
        name: merged.Name ?? null,
        last_modified: merged.LastModifiedDate ?? null,
        data: JSON.stringify(merged),
        synced_at: now(),
      });
    }
  });

  // `merge` lays a partial record (e.g. the dashboard's fields) over the stored copy instead of replacing it.
  const getOppData = db.prepare('SELECT data FROM opportunities WHERE org_id = ? AND id = ?');
  const saveOpportunities = db.transaction((orgId, recs, { merge = false } = {}) => {
    for (let rec of recs) {
      const prev = merge ? getOppData.get(orgId, rec.Id) : null;
      if (prev) rec = { ...JSON.parse(prev.data), ...rec };
      upsertOpp.run({
        org_id: orgId,
        id: rec.Id,
        account_id: rec.AccountId ?? null,
        name: rec.Name ?? null,
        last_modified: rec.LastModifiedDate ?? null,
        data: JSON.stringify(rec),
        synced_at: now(),
      });
    }
  });

  return {
    db,

    saveAccounts,
    saveOpportunities,

    // Save an account with its full opportunity list, dropping cached opportunities that
    // Salesforce no longer returns for it (deleted, or moved to another account).
    saveAccountDetail: db.transaction((orgId, account, opportunities) => {
      saveAccounts(orgId, [account], { replace: true });
      const keep = new Set(opportunities.map((o) => o.Id));
      for (const { id } of oppIdsForAccount.all(orgId, account.Id)) if (!keep.has(id)) deleteOpp.run(orgId, id);
      saveOpportunities(orgId, opportunities);
    }),

    // `mine`, when given, keeps only accounts where any of those { field, value } pairs holds (the
    // My Accounts filter); field names come from the org's describe, and are compared like SOQL does
    // (case-insensitively). Each of `match` (the SailPoint BOAT and SE filters) keeps accounts whose
    // { field } has that value (one of the values for a multi-select picklist), or none with `blank`.
    // `ownerId`, when given, keeps only accounts owned by that user (the sales rep filter).
    // Sorted A–Z by name, or most recently modified first with `recent`.
    listAccounts(orgId, { q = '', ownerId = '', recent = false, mine = null, match = [], limit = 200 } = {}) {
      const params = { orgId, q, ownerId, limit };
      const where = [];
      if (mine) {
        where.push('(' + (mine.length ? mine.map((m, i) => {
          params['minePath' + i] = '$.' + m.field;
          params['mineValue' + i] = m.value;
          return `lower(json_extract(a.data, @minePath${i})) = lower(@mineValue${i})`;
        }).join(' OR ') : '0') + ')');
      }
      match.forEach((m, i) => {
        const path = '@matchPath' + i, value = '@matchValue' + i;
        params['matchPath' + i] = '$.' + m.field;
        params['matchValue' + i] = m.type === 'boolean' ? (m.value === 'true' ? 1 : 0) : m.value;
        where.push(m.blank ? `coalesce(json_extract(a.data, ${path}), '') = ''`
          : m.type === 'multipicklist'
            ? `instr(';' || lower(json_extract(a.data, ${path})) || ';', ';' || lower(${value}) || ';') > 0`
            : `lower(json_extract(a.data, ${path})) = lower(${value})`);
      });
      const rows = db.prepare(`
        SELECT data, synced_at FROM accounts a
        WHERE org_id = @orgId
          AND (@q = '' OR instr(lower(name), lower(@q)) > 0)
          AND (@ownerId = '' OR json_extract(a.data, '$.OwnerId') = @ownerId)
          ${where.map((w) => 'AND ' + w).join('\n          ')}
        ORDER BY ${recent ? 'last_modified DESC' : 'lower(name) ASC'} LIMIT @limit
      `).all(params);
      return { records: rows.map((r) => JSON.parse(r.data)), syncedAt: oldest(rows) };
    },

    getAccountDetail(orgId, id) {
      const acct = db.prepare('SELECT data, synced_at FROM accounts WHERE org_id = ? AND id = ?').get(orgId, id);
      if (!acct) return null;
      const opps = db.prepare(`
        SELECT data, synced_at FROM opportunities WHERE org_id = ? AND account_id = ?
        ORDER BY json_extract(data, '$.IsClosed') ASC, json_extract(data, '$.CloseDate') ASC
      `).all(orgId, id);
      return {
        account: JSON.parse(acct.data),
        opportunities: opps.map((r) => JSON.parse(r.data)),
        syncedAt: oldest([acct, ...opps]),
      };
    },

    // Open opportunities for the Deals tab. `mine`, when given, keeps those whose saved account has any
    // of those { field, value } pairs (the My Accounts rule), compared case-insensitively like SOQL.
    listOpenOpportunities(orgId, { mine = null } = {}) {
      const params = { orgId };
      const where = mine ? '(' + (mine.length ? mine.map((m, i) => {
        params['minePath' + i] = '$.' + m.field;
        params['mineValue' + i] = m.value;
        return `lower(json_extract(a.data, @minePath${i})) = lower(@mineValue${i})`;
      }).join(' OR ') : '0') + ')' : '1';
      const rows = db.prepare(`
        SELECT o.data, o.synced_at, a.name AS account_name FROM opportunities o
        LEFT JOIN accounts a ON a.org_id = o.org_id AND a.id = o.account_id
        WHERE o.org_id = @orgId
          AND NOT coalesce(json_extract(o.data, '$.IsClosed'), 0)
          AND ${where}
        ORDER BY json_extract(o.data, '$.CloseDate') ASC
      `).all(params);
      return {
        records: rows.map((r) => {
          const rec = JSON.parse(r.data);
          return rec.Account?.Name || !r.account_name ? rec : { ...rec, Account: { Name: r.account_name } };
        }),
        syncedAt: oldest(rows),
      };
    },

    listHidden(orgId) {
      return db.prepare(`
        SELECT id, sobject AS type, name, hidden_at AS hiddenAt FROM hidden_records
        WHERE org_id = ? ORDER BY hidden_at DESC
      `).all(orgId);
    },

    hide: db.transaction((orgId, type, records) => {
      const ins = db.prepare(`
        INSERT INTO hidden_records (org_id, id, sobject, name, hidden_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (org_id, id) DO UPDATE SET name = excluded.name
      `);
      for (const r of records) ins.run(orgId, r.id, type, r.name ?? null, now());
    }),

    unhide: db.transaction((orgId, ids) => {
      const del = db.prepare('DELETE FROM hidden_records WHERE org_id = ? AND id = ?');
      for (const id of ids) del.run(orgId, id);
    }),

    // Marks for these event Ids: { [eventId]: { dsId, skipped } }.
    eventMarks(orgId, eventIds) {
      const get = db.prepare('SELECT ds_id, skipped FROM event_marks WHERE org_id = ? AND event_id = ?');
      const out = {};
      for (const id of eventIds) {
        const r = get.get(orgId, id);
        if (r) out[id] = { dsId: r.ds_id, skipped: !!r.skipped };
      }
      return out;
    },

    linkEvent(orgId, eventId, dsId) {
      db.prepare(`
        INSERT INTO event_marks (org_id, event_id, ds_id, skipped, updated_at) VALUES (?, ?, ?, 0, ?)
        ON CONFLICT (org_id, event_id) DO UPDATE SET ds_id = excluded.ds_id, skipped = 0, updated_at = excluded.updated_at
      `).run(orgId, eventId, dsId, now());
    },

    // Forget a deleted Deal Support's links to the events it was created from.
    unlinkDealSupport(orgId, dsId) {
      db.prepare('UPDATE event_marks SET ds_id = NULL, updated_at = ? WHERE org_id = ? AND ds_id = ?').run(now(), orgId, dsId);
    },

    // Mark (or unmark) an event as needing no Deal Support. Unmarking keeps any link.
    skipEvent(orgId, eventId, skipped) {
      db.prepare(`
        INSERT INTO event_marks (org_id, event_id, ds_id, skipped, updated_at) VALUES (?, ?, NULL, ?, ?)
        ON CONFLICT (org_id, event_id) DO UPDATE SET skipped = excluded.skipped, updated_at = excluded.updated_at
      `).run(orgId, eventId, skipped ? 1 : 0, now());
    },

    saveSetting(orgId, kind, value) {
      db.prepare(`
        INSERT INTO org_settings (org_id, kind, data, synced_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (org_id, kind) DO UPDATE SET data = excluded.data, synced_at = excluded.synced_at
      `).run(orgId, kind, JSON.stringify(value), now());
    },

    getSetting(orgId, kind) {
      const row = db.prepare('SELECT data FROM org_settings WHERE org_id = ? AND kind = ?').get(orgId, kind);
      return row ? JSON.parse(row.data) : null;
    },
  };
}

const oldest = (rows) => rows.reduce((min, r) => (!min || r.synced_at < min ? r.synced_at : min), null);
