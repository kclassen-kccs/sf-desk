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

## 1. Create an app in Salesforce (one-time)

In Setup, create an **External Client App** (or a classic **Connected App**) with OAuth enabled:

- **Callback URL:** `http://localhost:3000/oauth/callback`
- **OAuth scopes:** `Manage user data via APIs (api)` and `Perform requests at any time (refresh_token, offline_access)`
- **Require PKCE:** on
- **Require secret for Web Server Flow:** off is simplest (if on, put the secret in `.env`)

Copy the **Consumer Key**. New apps can take a few minutes before logins work.

If your org restricts API access, your admin may need to approve the app or give your profile
the "API Enabled" permission.

## 2. Configure and run

Requires Node.js 18 or newer.

```bash
cd sf-desk
cp .env.example .env      # then paste your Consumer Key into SF_CLIENT_ID
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
- Tokens are held in server memory for the session; nothing is written to disk. Restarting the app means reconnecting.
- **Disconnect** revokes the token with Salesforce.
