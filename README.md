# SF Desk

A small local web app for viewing and editing your Salesforce Accounts and Opportunities.
It uses the Salesforce REST API with your own OAuth login, so it only sees and changes what
your Salesforce user is already allowed to, and it only writes when you click **Save** or **Add**.

## What it does

- Lists accounts (yours by default, or all you can see) with search
- Shows account details plus all its opportunities, with open pipeline total
- Edits account fields and opportunity fields inline; changed fields are highlighted before saving
- Creates new opportunities on an account
- Picklists (Type, Industry, Stage) come from your org; fields you can't edit are greyed out
- If someone else changed a record after you loaded it, the save is refused rather than overwriting their work
- Keeps a local SQLite copy of every account and opportunity you load, so if Salesforce can't be reached
  you can still browse what you last saw (read-only until the connection is back)

## 1. Choose how to sign in (one-time)

### Option A: Salesforce CLI login (no app needed)

If you can't create an External Client App, SF Desk can reuse the login from the Salesforce CLI.
This works with SSO, because the CLI signs you in through your normal browser login.

1. Install the CLI from Salesforce's macOS installer (the `.pkg` at
   https://developer.salesforce.com/tools/salesforcecli). Don't use `npm install @salesforce/cli`;
   that needs registry.npmjs.org, which some company networks block.
2. Sign in once: `sf org login web --set-default` (add `--instance-url https://yourcompany.my.salesforce.com`
   for a My Domain/SSO login, or `--alias work` to name it).
3. Leave `SF_CLIENT_ID` empty in `.env`. If you used an alias, set `SF_TARGET_ORG=work`.

SF Desk runs `sf org display` (and `sf org auth show-access-token` on CLI versions that hide the token there) when you click **Connect** and whenever the token expires.
**Disconnect** only signs SF Desk out; your CLI login stays as it is (`sf org logout` ends that).

### Option B: Create an app in Salesforce

In Setup, create an **External Client App** (or a classic **Connected App**) with OAuth enabled:

- **Callback URL:** `http://localhost:3000/oauth/callback`
- **OAuth scopes:** `Manage user data via APIs (api)` and `Perform requests at any time (refresh_token, offline_access)`
- **Require PKCE:** on
- **Require secret for Web Server Flow:** off is simplest (if on, put the secret in `.env`)

Copy the **Consumer Key**. New apps can take a few minutes before logins work.

If your org restricts API access, your admin may need to approve the app or give your profile
the "API Enabled" permission.

## 2. Configure and run

Requires Node.js 22 or newer.

```bash
cd sf-desk
cp .env.example .env      # Option B: paste your Consumer Key into SF_CLIENT_ID
npm install
npm start
```

Open http://localhost:3000 and click **Connect**.

Sandbox? Set `SF_LOGIN_URL=https://test.salesforce.com`. Using a My Domain login? Use that URL.

## Changing which fields appear

Edit `ACCOUNT_FIELDS` / `OPP_FIELDS` near the top of `server.js` (the server only allows writes
to those fields), and `ACCOUNT_UI` / `OPP_UI` near the top of `public/index.html` to show them.
Custom fields work too, e.g. `Region__c`.

## Security notes

- The server listens on `localhost` only.
- Tokens are held in server memory for the session and never written to disk. Restarting the app means reconnecting.
- Account and opportunity records you load are saved to `data/sf-desk.db` (set `SF_DESK_DB` to move it).
  Delete that file to clear the local copy; it is rebuilt as you browse. Edits always go straight to
  Salesforce; nothing is queued locally.
- **Disconnect** revokes the token with Salesforce.
