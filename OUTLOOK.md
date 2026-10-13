# SF Desk in Outlook

The SF Desk add-in puts a **Create Deal Support** button on meetings in Outlook. It opens a panel beside the
meeting with the same form as the **Time Entry** tab, prefilled from that meeting:

- the opportunity, from the Salesforce copy of the meeting at the same time (e.g. synced by Outreach), else
  suggested from the account named in the title or the attendees' email domains
- the name from the title, the activity date, the meeting time in hours, and the description without the
  Teams or Zoom joining details (when nothing else is written, "Requested Activity - Platform Request")
- you as the Assigned SE, and Role set to Lead SE

The panel also shows the Deal Supports that already cover the meeting (made from it, or yours on the same day
for the same opportunity, account or name). Everything runs through SF Desk on your Mac, so SF Desk must be
running for the button to work. It only reads the meeting you click it on, and nothing is saved until you
click **Create Deal Support**.

The add-in signs in with your Salesforce CLI login (Option A in the README); with that, it connects by itself
the first time you open it. It doesn't work with the OAuth app login (Option B).

## 1. Make the HTTPS certificate (one time)

Outlook only loads add-ins over HTTPS, so SF Desk also listens on `https://localhost:3443` once it has a
certificate. In the SF Desk folder, in Terminal:

```bash
sh scripts/outlook-cert.sh --trust
```

This uses the `openssl` that comes with macOS (nothing is downloaded). It makes a small certificate
authority of your own ("SF Desk local CA") and a `localhost` certificate signed by it, in `certs/`, then asks
for your Mac password to trust the authority in your login keychain. Only your user trusts it, and its key
never leaves `certs/`, which git ignores.

Then restart SF Desk (`npm start`). The terminal now also shows
`Outlook add-in served at https://localhost:3443/outlook/pane`. Open that address in Safari to check: it
should load without a certificate warning. Set `HTTPS_PORT` in `.env` to use another port.

The certificate lasts 825 days (the most macOS allows); `sh scripts/outlook-cert.sh --renew` makes a new one.

## 2. Add the add-in to Outlook (one time)

1. With SF Desk running, open https://localhost:3443/outlook/manifest.xml in Safari. It downloads
   `sf-desk-outlook.xml`, the add-in's manifest, already pointing at your HTTPS port.
2. Open https://aka.ms/olksideload in your browser and sign in with your work account. It opens Outlook on
   the web's **Add-ins for Outlook** window. (In Outlook for Mac you can also click **Get Add-ins**, or
   **•••** > **Get Add-ins**.)
3. Choose **My add-ins**, scroll to **Custom Addins**, click **Add a custom add-in** > **Add from File...**,
   pick `sf-desk-outlook.xml` and confirm the warning.

Add-ins are installed on your mailbox, so it shows up in Outlook for Mac after a minute or a restart of Outlook.

**If there is no "Custom Addins" section, or adding the file fails:** your company's Microsoft 365 admin
policy may block custom add-ins (the Exchange "My Custom Apps" user role). That can only be changed by IT,
for example by deploying the manifest to you from the Microsoft 365 admin center. Until then, the Time Entry
tab in SF Desk does the same thing.

## 3. Use it

Open a meeting in your Outlook calendar (double-click it, or select it to show it in the reading pane) and
click **Create Deal Support** in its toolbar (it may be under **•••** or **Apps**). The panel shows the
meeting, then the form. Check the opportunity and fields and click **Create Deal Support**.

If the panel says it can't connect, check that SF Desk is running and that you are signed in to the
Salesforce CLI (`sf org display`); then click **Connect** in the panel.

## Remove it

- In Outlook: **Get Add-ins** > **My add-ins** > SF Desk > **•••** > **Remove**.
- The certificate: `security delete-certificate -c "SF Desk local CA"` (or delete it in Keychain Access), then
  delete the `certs/` folder. SF Desk stops listening on HTTPS when `certs/` is gone.

## How it works

- `outlook/manifest.xml` is the add-in manifest (XML, for sideloading). SF Desk serves it at
  `/outlook/manifest.xml` with your `HTTPS_PORT` filled in.
- The panel is `https://localhost:3443/outlook/pane`: SF Desk's own page with Microsoft's Office.js added. It
  reads the meeting (subject, time, location, body and attendees) and sends it to `POST /api/outlook/event`,
  which finds the matching Salesforce event and covering Deal Supports and returns the prefill. Creating
  goes through the same endpoint as Time Entry, which remembers the meeting in the local database.
- The HTTPS listener has its own session cookie (`sfdesk.sid`, `SameSite=None; Secure`) because Outlook's
  web view keeps cookies apart from your browser. Like the HTTP one, it only listens on `localhost`.
