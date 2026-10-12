# SF Desk

A small local web app for viewing and editing your Salesforce Accounts and Opportunities.
It uses the Salesforce REST API with your own OAuth login, so it only sees and changes what
your Salesforce user is already allowed to, and it only writes when you click **Save** or **Add**.

## What it does

- Opens on a **Dashboard** of your open pipeline (the opportunities where you are Lead SE, minus anything you
  hid): total and weighted pipeline, totals by stage, and a forecast by close date per fiscal month, quarter or
  year, stacked by forecast category. Click a bar to list its deals, and a deal to open it. The fiscal year
  starts Feb 1 and is named for the calendar year it ends in (FY27 = Feb 2026 – Jan 2027)
- **My Time** totals the hours on your Deal Supports across all opportunities: this week, the previous week,
  the last 30 days, this fiscal quarter and this fiscal year, hours per week for the last 13 weeks, and hours
  per opportunity for any of those periods. Click a tile, week or opportunity to list its activities. Weeks
  start on Monday
- **My Calendar** shows your Salesforce calendar (the Event records you own) a week at a time. Events with a
  Deal Support are green, events without one are red, and ones you mark **No Deal Support needed** turn grey.
  Click an event to see its details, then **Create Deal Support**: pick the opportunity (the event's own one is
  preselected when it has one) and the form is prefilled from the event: name from the subject, activity date
  from the start, meeting duration in hours, the event description in the details field, and you as the
  Assigned SE. An event counts as covered when a Deal Support was created from it here (remembered in the local
  database), or when one of yours has the same activity date and the event's opportunity or subject. Meetings
  that reach Salesforce only through Einstein Activity Capture aren't stored as Events, so they can't be shown
- Lists accounts where you are the Lead SE by default (or all you can see) with search
- Shows account details plus its opportunities (only the ones where you are Lead SE, unless you untick the filter), with open pipeline total
- Lists accounts A–Z by name (or most recently modified first); filters the list to one sales rep and/or groups it by sales rep (the sales rep is the account owner)
- Shows only open opportunities on an account by default; tick **Show closed** to see all of them
- Edits account fields and opportunity fields inline; changed fields are highlighted before saving
- Creates new opportunities on an account
- **Open** on an opportunity focuses on it: edit its fields, see its Deal Support records (click one for all
  its fields), and create new ones with a form built from your org's Deal Support fields
- Hide accounts and opportunities you don't want to see: tick them and click **Hide**. Tick **Show hidden**
  to see them again and **Unhide** them. Hiding is stored only in the local database, never in Salesforce
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

## Lead SE filter

By default the app only shows accounts and opportunities where you are the **Lead SE**. An account
counts if you are its Lead SE, or the Lead SE on any of its opportunities. The app finds the field by
its label "Lead SE" on Account and Opportunity. If yours is labelled differently, set
`SF_LEAD_SE_FIELD` in `.env` to its API name (e.g. `Lead_SE__c`). A user lookup field is matched
against your Salesforce user; a text or picklist field is matched against your full name.

## Changing which fields appear

Edit `ACCOUNT_FIELDS` / `OPP_FIELDS` near the top of `server.js` (the server only allows writes
to those fields), and `ACCOUNT_UI` / `OPP_UI` near the top of `public/index.html` to show them.
Custom fields work too, e.g. `Region__c`.

## Deal Support

SF Desk finds the Deal Support object by its label ("Deal Support") and uses its lookup to Opportunity.
The new-record form shows the fields on its page layout (for your default record type): required ones first,
the rest under **More fields**. To pick the fields yourself, set `SF_DEAL_SUPPORT_FIELDS` in `.env` to a
comma-separated list of API names.
If it can't find the object, set `SF_DEAL_SUPPORT_OBJECT` in `.env` to its API name (e.g. `Deal_Support__c`);
if the object has more than one lookup to Opportunity, set `SF_DEAL_SUPPORT_OPP_FIELD` to the right one.
Deal Supports are read live from Salesforce and aren't kept in the local copy, except the last My Time load,
which is saved so the page still shows something offline.

### My Time

My Time reads every Deal Support where you are the user in a lookup field, and picks three fields:

- **Mine by**: the user lookup with the most records naming you (e.g. Assigned SE), checked with a count per field
- **Hours from**: the hours or duration field filled on the most of your records, preferring a total-hours field on
  a tie (rates, costs and amounts are skipped). Numbers count as hours unless the field says minutes; text
  values like "30 min" or "1.5 hours" are parsed
- **Date**: `Date_of_Sales_Activity__c` (Date of Activity) if present, else an activity date field, else Created Date

The dropdowns show how many of your records each field covers.
The page shows which fields it used and has a dropdown for each; your choice is remembered in this browser.
To pin them for everyone, set `SF_TIME_USER_FIELD`, `SF_TIME_HOURS_FIELD` or `SF_TIME_DATE_FIELD` in `.env`
to the field's API name.

## Security notes

- The server listens on `localhost` only.
- Tokens are held in server memory for the session and never written to disk. Restarting the app means reconnecting.
- Account and opportunity records you load are saved to `data/sf-desk.db` (set `SF_DESK_DB` to move it).
  Delete that file to clear the local copy; it is rebuilt as you browse. Edits always go straight to
  Salesforce; nothing is queued locally.
- **Disconnect** revokes the token with Salesforce.
