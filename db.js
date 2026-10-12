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
      owner_id      TEXT,
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

    CREATE TABLE IF NOT EXISTS org_meta (
      org_id    TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
  `);

  const now = () => new Date().toISOString();

  const upsertAccount = db.prepare(`
    INSERT INTO accounts (org_id, id, name, owner_id, last_modified, data, synced_at)
    VALUES (@org_id, @id, @name, @owner_id, @last_modified, @data, @synced_at)
    ON CONFLICT (org_id, id) DO UPDATE SET
      name = excluded.name,
      owner_id = excluded.owner_id,
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
        owner_id: merged.OwnerId ?? null,
        last_modified: merged.LastModifiedDate ?? null,
        data: JSON.stringify(merged),
        synced_at: now(),
      });
    }
  });

  const saveOpportunities = db.transaction((orgId, recs) => {
    for (const rec of recs) {
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

    listAccounts(orgId, { q = '', ownerId = null, limit = 200 } = {}) {
      const rows = db.prepare(`
        SELECT data, synced_at FROM accounts
        WHERE org_id = @orgId
          AND (@q = '' OR instr(lower(name), lower(@q)) > 0)
          AND (@ownerId IS NULL OR owner_id = @ownerId)
        ORDER BY last_modified DESC LIMIT @limit
      `).all({ orgId, q, ownerId, limit });
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

    saveMeta(orgId, meta) {
      db.prepare(`
        INSERT INTO org_meta (org_id, data, synced_at) VALUES (?, ?, ?)
        ON CONFLICT (org_id) DO UPDATE SET data = excluded.data, synced_at = excluded.synced_at
      `).run(orgId, JSON.stringify(meta), now());
    },

    getMeta(orgId) {
      const row = db.prepare('SELECT data FROM org_meta WHERE org_id = ?').get(orgId);
      return row ? JSON.parse(row.data) : null;
    },
  };
}

const oldest = (rows) => rows.reduce((min, r) => (!min || r.synced_at < min ? r.synced_at : min), null);
