# SF Desk

A small local app for viewing and editing your Salesforce Accounts and Opportunities, and logging your
time as Deal Supports. It runs on your own computer, as **SF Desk.app** on a Mac or as a local web server
you open in the browser. It uses the Salesforce REST API with your own login, so it only sees and changes
what your Salesforce user is already allowed to, and it only writes when you click **Save** or **Add**.

**Setting it up on a SailPoint Mac?** Use the **SF Desk app**: open `SF-Desk.dmg`, drag SF Desk to Applications and open it.
Everything it needs is inside, and it walks you through the Salesforce sign-in
([INSTALL.md](INSTALL.md#the-sf-desk-app-recommended)). INSTALL.md also covers running SF Desk from a Git
checkout (Node, the Salesforce CLI login, getting dependencies past the npm block), the Exchange calendar,
calendar permission and troubleshooting.

## What it does

- Opens on the **Deals** tab, a dashboard of your open pipeline (the opportunities where you are Lead SE, minus anything you
  hid): total and weighted pipeline, totals by stage, and a forecast by close date per fiscal month, quarter or
  year, stacked by forecast category. Click a bar to list its deals, and a deal to open it. The fiscal year
  starts Feb 1 and is named for the calendar year it ends in (FY27 = Feb 2026 – Jan 2027)
- **My Time** totals the hours on your Deal Supports across all opportunities: this week, the previous week,
  the last 30 days, this fiscal quarter and this fiscal year, hours per week for the last 13 weeks, and hours
  per opportunity for any of those periods. Click a tile, week or opportunity to list its activities (the pencil
  on a row edits that Deal Support). Weeks
  start on Monday
- **Export to Excel** on the Pipeline deal list and the My Time activity list downloads the rows shown (after
  filters, hidden records and any clicked bar, tile or opportunity) as an .xlsx with typed dates, amounts and
  hours, a total row and a link to each record
- **Time Entry** shows your calendar a week at a time. On a Mac it reads the calendars from your Internet
  Accounts (System Settings > Internet Accounts), starting with the Exchange account's calendar if there is
  one; pick another calendar, or **Salesforce events** (the Event records you own), from the list at the top.
  The first time, macOS asks to let SF Desk access your calendars (when you run the server yourself, it asks
  for the app you started it from, e.g. Terminal); if you say no, the tab says so and shows Salesforce events.
  The calendar reader (`mac/calendar.swift`) is built into the Mac app; a checkout builds it with the Xcode
  Command Line Tools on first use, and without them asks Calendar.app instead, which is slower.
  Events with a Deal Support are green, events without one are red, and ones you mark **No Deal Support needed**
  turn grey. Click an event to see its details, then **Create Deal Support**: type to find the opportunity among
  all open opportunities (opportunities on accounts named in the meeting title come first), and the form is
  prefilled from the event: name from the title, activity date from the start, meeting duration in hours, the
  event description in the details field (without the Teams, Zoom or Webex joining details; when nothing else is
  written, the details default to "Requested Activity - Platform Request" from the form), and you as the Assigned SE. An event counts as covered when a Deal
  Support was created from it here (remembered in the local database), or when one of yours has the same
  activity date and the same opportunity, account or name. For Mac calendar events the account and opportunity
  come from the matching Salesforce event (e.g. synced by Outreach) at the same time, else from the meeting
  title and the attendees' email domains. Salesforce events logged twice at the same time (e.g. by
  Outreach, on the account and on the opportunity) are shown once. The open opportunity list is kept in the
  local database and refreshed from Salesforce every 4 hours. Under the calendar is the list of your Deal
  Supports dated that week; the pencil on a row opens it in the same form to edit (only changed fields are saved)
- **Outlook add-in** (optional): a **Create Deal Support** button on Outlook meetings opens the same prefilled
  form beside the meeting. See [OUTLOOK.md](OUTLOOK.md) to set it up
- Works from phone width up to wide desktops: on phones the tabs fold into a ☰ menu, Accounts shows the list
  or the account (with a back button), Time Entry lists the week day by day, and list tables become cards; on wide
  screens (1100px and up) Time Entry keeps a panel beside the calendar for entering time: the selected event and its
  create form, the Deal Support being edited, or a prompt when nothing is picked
- Lists accounts where you are the Lead SE by default (or all you can see) with search
- The account screen shows the sales rep prominently, and a **Deal Supports** panel with everyone's Deal Supports
  on the account and its opportunities for the last 30, 60 or 90 days or the fiscal year to date: count, total
  hours and the list (click one to open it in Salesforce; the pencil edits it)
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

## The Mac app

SF Desk.app (source in `mac/app`, built by `scripts/build-mac-app.sh`; see
[INSTALL.md](INSTALL.md#the-sf-desk-app-recommended)) carries the server, Node.js and the calendar reader, and
shows SF Desk in its own window. On first launch it downloads the Salesforce CLI if you don't have one and
signs you in (Option A below), so the setup steps that follow are only for running from a checkout.

- **Settings:** the `.env` settings below live in `~/Library/Application Support/SF Desk/.env`. Open it
  with **SF Desk > Edit Settings...**, then **File > Restart Server**.
- **Data:** the same folder holds `data/` (the local copy), `certs/` (the Outlook certificate) and `sf-cli/`
  if the app downloaded the CLI. Updating the app keeps all of it. The first launch copies these from
  `~/SF-Desk` or a Git checkout.
- **Running:** closing the window keeps SF Desk running in the background (for the Outlook add-in); click
  the Dock icon to get it back, and quit to stop it. **File > Open in Browser** opens the same SF Desk in
  your browser. If SF Desk is already running (e.g. `npm start` in a checkout), the app shows that one.
- **Logs:** `~/Library/Logs/SF Desk/server.log` (**Help > Show Server Log**).

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

## Accounts filters

The Accounts tab shows **My Accounts** by default: accounts where you are in any of these Account
fields: Account Owner, Lead SE, Lead SE Manager, ATS, DSR, CSM, CSM Manager or Services Manager. The
app finds each by its label (with or without an "Account " prefix); hover over the dropdown to see
which fields it found. If some are labelled differently, set `SF_MY_ACCOUNT_FIELDS` in `.env` to the
full comma-separated list of API names. A user lookup field is matched against your Salesforce user;
a text field is matched against your full name. Pick **All accounts** to see everything.

The **SailPoint BOAT** dropdown filters on the Account field labelled "SailPoint BOAT" (set
`SF_BOAT_FIELD` to its API name if it isn't found).

The **SE** dropdown (All SEs by default) narrows the list to one Account Lead SE. It offers everyone
who is Lead SE on some account. While a SailPoint BOAT is picked, the SE and sales rep dropdowns
only list people with accounts in that BOAT.

## Deals tab

The Deals tab uses the same **My Accounts / All accounts** choice as the Accounts tab: with My
Accounts it shows the open opportunities on accounts where you are in any of the role fields above.

## Changing which fields appear

Edit `ACCOUNT_FIELDS` / `OPP_FIELDS` near the top of `server.js` (the server only allows writes
to those fields), and `ACCOUNT_UI` / `OPP_UI` near the top of `public/index.html` to show them.
Custom fields work too, e.g. `Region__c`.

## Deal Support

SF Desk finds the Deal Support object by its label ("Deal Support") and uses its lookup to Opportunity.
The new-record form shows the fields on its page layout (for your default record type): required ones first,
the rest under **More fields**. To pick the fields yourself, set `SF_DEAL_SUPPORT_FIELDS` in `.env` to a
comma-separated list of API names. **More fields** starts closed. Platform Capabilities and Integration
Modules are optional on the form even though the layout requires them (`SF_DEAL_SUPPORT_OPTIONAL` lists the
fields treated this way); if Salesforce itself requires one, the save fails with its message and the field is
shown. Role starts as **Lead SE** when that is one of its values.
If it can't find the object, set `SF_DEAL_SUPPORT_OBJECT` in `.env` to its API name (e.g. `Deal_Support__c`);
if the object has more than one lookup to Opportunity, set `SF_DEAL_SUPPORT_OPP_FIELD` to the right one.
Deal Supports are read live from Salesforce and aren't kept in the local copy, except the last My Time load,
which is saved so the page still shows something offline.

### My Time

My Time reads every Deal Support where you are the user in a lookup field, and picks three fields:

- **Mine by**: `Regional_SE_IDN__c` (Assigned SE) if present, else the user lookup with the most records naming you
- **Hours from**: `Total_Time_Hours__c` (Total Time (Hours)) if present, else the hours or duration field filled on
  the most of your records, preferring a total-hours field on a tie (rates, costs and amounts are skipped).
  Numbers count as hours unless the field says minutes; text values like "30 min" or "1.5 hours" are parsed
- **Date**: `Date_of_Sales_Activity__c` (Date of Activity) if present, else an activity date field, else Created Date

The dropdowns show how many of your records each field covers. A pick other than the default is remembered in this browser.
The page shows which fields it used and has a dropdown for each; your choice is remembered in this browser.
To pin them for everyone, set `SF_TIME_USER_FIELD`, `SF_TIME_HOURS_FIELD` or `SF_TIME_DATE_FIELD` in `.env`
to the field's API name.

## Security notes

- The server listens on `localhost` only.
- Tokens are held in server memory for the session and never written to disk. Restarting the app means reconnecting.
- Account and opportunity records you load are saved to `data/sf-desk.db` (set `SF_DESK_DB` to move it;
  the Mac app keeps it in `~/Library/Application Support/SF Desk/data`).
  Delete that file to clear the local copy; it is rebuilt as you browse. Edits always go straight to
  Salesforce; nothing is queued locally.
- **Disconnect** revokes the token with Salesforce.
- For the Outlook add-in, SF Desk also listens on `https://localhost:3443` (still `localhost` only) once
  `certs/` holds the certificate from `scripts/outlook-cert.sh` (or **Set Up Outlook Add-in...** in the Mac
  app). Its keys stay in `certs/`, which git ignores.
