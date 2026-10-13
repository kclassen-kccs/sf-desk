# Installing SF Desk on a SailPoint Mac

SF Desk runs entirely on your Mac. It signs in to Salesforce as you, through the Salesforce CLI, and
only sees and changes what your own Salesforce user can. Nothing is hosted anywhere else.

## The SF Desk app (recommended)

**SF Desk.app** has everything inside it: the SF Desk server, Node.js, its dependencies and the calendar
reader. There's nothing else to install, no Terminal window to keep open, and macOS asks SF Desk itself
for calendar access.

1. **Set up your calendar first.** In **System Settings > Internet Accounts**, add your SailPoint
   Exchange account if it isn't there (**Add Account... > Microsoft Exchange**, sign in with your
   SailPoint email) and turn on **Calendars**. Check that this week's meetings show in Calendar.app.
2. **Get `SF-Desk.dmg`** from Kerry Classen and double-click it. In the window that opens, drag **SF Desk**
   onto the **Applications** folder. The window also has short install instructions ("Read Me First"), the
   Outlook add-in guide and the full SF Desk guide. Then eject the disk image. (`SF-Desk-app.zip` has just the app:
   double-click it and drag **SF Desk** into Applications.)
3. **Open it once with Open Anyway.** The app isn't signed by Apple, so the first time macOS says it
   can't verify the developer. Click **Done**, open **System Settings > Privacy & Security**, scroll
   down, click **Open Anyway** next to "SF Desk" and confirm with your password. (On some macOS versions
   right-click > **Open** > **Open** works too.) You only do this once per new version.
4. **Follow its prompts.** The first time, SF Desk:
   - copies your settings and data from an earlier install (`~/SF-Desk`) or Git checkout, if you have one;
   - offers to download the Salesforce CLI if it can't find one (no admin rights needed);
   - opens your browser to sign in to `sailpoint.my.salesforce.com` with SSO, if the CLI isn't signed in.
5. **Click Connect**, then open **Time Entry**. When macOS asks whether **SF Desk** may access your
   calendars, choose **Allow Full Access**.

Keep SF Desk in the Dock (right-click its icon > **Options > Keep in Dock**). Closing the window keeps it
running in the background, so the Outlook add-in keeps working; click the Dock icon to bring it back, and
quit it (**SF Desk > Quit SF Desk**) to stop it. If SF Desk is already running from a Terminal window or a
checkout, the app shows that one instead of starting another.

**Your data** lives in `~/Library/Application Support/SF Desk` (**Help > Show Data Folder**): `.env` for
settings (**SF Desk > Edit Settings...**, then **File > Restart Server**), `data/` for the local copy of
your records, `certs/` for the Outlook add-in's certificate and `sf-cli/` if the app downloaded the CLI.
To update, replace the app with the new one; all of that is kept. The server's log is in
`~/Library/Logs/SF Desk` (**Help > Show Server Log**).

**Outlook add-in:** choose **SF Desk > Set Up Outlook Add-in...** (or say yes when the app offers it the
first time). It trusts its HTTPS certificate (macOS asks for your password), saves the add-in file to
Downloads and opens Outlook's add-in page; there, choose **My add-ins > Custom Addins > Add a custom
add-in > Add from File...** and pick `sf-desk-outlook.xml`. See [OUTLOOK.md](OUTLOOK.md).

**Uninstalling:** quit SF Desk, delete it from Applications, and delete
`~/Library/Application Support/SF Desk` and `~/Library/Logs/SF Desk`.

If calendar access goes missing after updating to a new build, open **System Settings > Privacy &
Security > Calendars**, remove SF Desk with the minus button (or turn it off and on), and open Time Entry
again. macOS ties the permission to each unsigned build.

### Building the app

The app has to be compiled on a Mac with the Xcode Command Line Tools (`xcode-select --install`). Its
`node_modules` and Node.js come from the same download as the Terminal installer below, which can be
built anywhere npm and nodejs.org are reachable. So:

1. Anywhere (e.g. in the cloud): `scripts/build-mac-package.sh` writes `dist/SF-Desk-mac.zip`. Only
   redo this when `package-lock.json` changes.
2. On a Mac: `scripts/build-mac-app.sh --from path/to/SF-Desk-mac.zip`. It takes SF Desk itself from the
   checkout's current commit, compiles the app and the calendar reader for Apple Silicon and Intel, puts the server, its
   `node_modules` and Node.js inside, signs it ad hoc, and writes `dist/SF Desk.app`, `dist/SF-Desk-app.zip`
   and `dist/SF-Desk.dmg`. The disk image, the file to hand out, holds the app, a shortcut to Applications
   and, as web pages made by `scripts/md-to-html.mjs`, a short install guide (`mac/app/READ ME FIRST.md`),
   the README and OUTLOOK.md.

With `node_modules` in your checkout and a nodejs.org build of Node, `scripts/build-mac-app.sh --node
/path/to/node` skips step 1. The bundled Node is for Apple Silicon; on an Intel Mac the app uses Node.js
22 or newer installed from nodejs.org instead.

## Quick install with the Terminal installer

Get `SF-Desk-mac.zip` from Kerry Classen. It bundles everything SF Desk needs on an Apple Silicon Mac
(Node.js and all dependencies), so there's no npm, Git or Node install, and Cisco Umbrella's npm
block doesn't matter.

1. **Set up your calendar first.** In **System Settings > Internet Accounts**, add your SailPoint
   Exchange account if it isn't there (**Add Account... > Microsoft Exchange**, sign in with your
   SailPoint email) and turn on **Calendars**. Check that this week's meetings show in Calendar.app.
2. **Unzip the download** and double-click **Install SF Desk.command**. If macOS says it can't verify
   the developer, click **Done**, then go to **System Settings > Privacy & Security**, scroll down,
   click **Open Anyway** next to the file and confirm. (Right-click > **Open** also works on some
   macOS versions.)
3. **Follow the Terminal window.** The installer:
   - copies SF Desk into `~/SF-Desk`;
   - asks to install the Xcode Command Line Tools if they're missing (click **Install**);
   - downloads the Salesforce CLI from Salesforce into `~/SF-Desk/sf-cli` if you don't have it (no
     admin rights needed);
   - opens your browser to sign in to `sailpoint.my.salesforce.com` with SSO, once;
   - offers to open Internet Accounts so you can check the calendar;
   - puts **Start SF Desk** on your Desktop and starts SF Desk.
4. **Allow calendar access.** When macOS asks whether Terminal may access your calendars, choose
   **Allow Full Access**. SF Desk opens at http://localhost:3000; click **Connect**.

From then on, double-click **Start SF Desk** on your Desktop. Keep its Terminal window open while you
use SF Desk, and close it to stop SF Desk. To update, unzip a newer download and run the installer
again; your settings, login and data in `~/SF-Desk` are kept. To uninstall, delete `~/SF-Desk` and the
Desktop launcher.

On an Intel Mac, install Node.js 22 or newer from https://nodejs.org first; the installer uses it
instead of the bundled one.

### Building the download

From a checkout of this repo, on any machine that can reach the npm registry and nodejs.org (so not
on the SailPoint network), run:

```bash
scripts/build-mac-package.sh            # or: scripts/build-mac-package.sh v26.11.1
```

It writes `dist/SF-Desk-mac.zip` from the current commit, with `node_modules` from the lockfile and
Node.js for Apple Silicon (checked against nodejs.org's checksums). Rebuild it whenever you want to
hand out a new version.

## Manual install

Use this if you'd rather work from a Git checkout, for example to change the code. It takes about
20 minutes, most of it waiting on installers.

### What you need

| Requirement | Why | Check |
|---|---|---|
| A Mac on macOS 14 (Sonoma) or newer, Apple Silicon or Intel | Built and tested on Apple Silicon (arm64) | Apple menu > **About This Mac** |
| Node.js 22 or newer | Runs the app (built and tested on Node 26) | `node -v` |
| Git (or GitHub Desktop) and read access to `kclassen-kccs/sf-desk` | To get the code; ask Kerry Classen for access | `git --version` |
| Salesforce CLI (`sf`) | SF Desk borrows its login, because we can't create our own Salesforce app | `sf --version` |
| A Salesforce login to `sailpoint.my.salesforce.com` with API access | Your normal SSO login is fine | |
| Your SailPoint Exchange account added to the Mac and syncing in Calendar.app | The **Time Entry** tab reads your meetings from it | Your meetings show in Calendar.app |
| Xcode Command Line Tools (recommended) | Builds the small calendar reader; without them the calendar is slower and less complete | `xcode-select -p` |

Run every command below in **Terminal.app** (Applications > Utilities > Terminal). Calendar
permission is granted to the app that starts SF Desk, and Terminal is the one that's known to work.

### 1. Install the tools

#### Node.js

Download the macOS installer (`.pkg`) for the current LTS or newer from https://nodejs.org and run it.
Then open a new Terminal window and check:

```bash
node -v    # v22.0.0 or newer
```

#### Salesforce CLI

Download the macOS installer (`.pkg`) from https://developer.salesforce.com/tools/salesforcecli and run it.

Don't use `npm install -g @salesforce/cli`. Cisco Umbrella on SailPoint Macs blocks the npm registry
(`registry.npmjs.org`), so that fails.

```bash
sf --version
```

#### Xcode Command Line Tools

```bash
xcode-select --install
```

Accept the dialog and wait for it to finish. If it says they're already installed, you're set.

### 2. Make sure your SailPoint calendar is on the Mac

SF Desk doesn't talk to Outlook or Microsoft 365 directly. It reads the calendars macOS already
syncs, so your SailPoint Exchange account has to be set up in macOS, not just in the Outlook app.

1. Open **System Settings > Internet Accounts**.
2. If there's no **Exchange** account for your `@sailpoint.com` address, click **Add Account... >
   Microsoft Exchange**, enter your SailPoint email, choose **Sign In**, and finish the Microsoft SSO
   and MFA prompts.
3. Open the Exchange account and make sure **Calendars** is turned on.
4. Open **Calendar.app** and check that this week's meetings appear under the Exchange account in
   the sidebar. Give a new account a few minutes to sync the first time.

If your meetings aren't in Calendar.app, SF Desk can't see them either. Fix this step before going on.

### 3. Sign in to Salesforce with the CLI

```bash
sf org login web --instance-url https://sailpoint.my.salesforce.com --set-default
```

A browser window opens to the SailPoint Salesforce login. Sign in with SSO as usual, allow access, and
return to Terminal when it says you're logged in. You only do this once; the CLI keeps you signed in.

Check it worked:

```bash
sf org display
```

It should show `sailpoint.my.salesforce.com` as the Instance Url and your username. If you named the
login with `--alias`, you'll set that alias in `.env` in step 5.

### 4. Get the code and its dependencies

```bash
cd ~/Documents
git clone https://github.com/kclassen-kccs/sf-desk.git SF-Desk
cd SF-Desk
```

(With GitHub Desktop: **File > Clone Repository**, then `cd` into the folder it made.)

SF Desk needs four npm packages: `express`, `express-session`, `dotenv` and `better-sqlite3`. The
last one is a native module (SQLite), but it ships prebuilt binaries for Apple Silicon and Intel
Macs, so nothing gets compiled.

**If the npm registry is reachable** (for example off the corporate network):

```bash
npm install
```

**On the SailPoint network**, where Umbrella blocks `registry.npmjs.org`, take the ready-made
`node_modules` folder from the `build/local-deps-75e52w` branch instead. GitHub isn't blocked, so this
works anywhere:

```bash
git fetch origin build/local-deps-75e52w
git archive origin/build/local-deps-75e52w node_modules | tar -x
```

This unpacks `node_modules` into the project folder without switching branches (git ignores the
folder, so it never shows up as a change). To check it worked:

```bash
node -e "require('better-sqlite3'); console.log('ok')"
```

That branch matches the current `package-lock.json`. If a future update changes `package-lock.json`,
the branch needs rebuilding before this step will work again; ask in the SF-Desk project.

### 5. Configure

```bash
cp .env.example .env
```

For a SailPoint install you normally don't change anything. Leave `SF_CLIENT_ID` empty so SF Desk uses
your CLI login. Only set these if they apply:

- `SF_TARGET_ORG=` the alias or username, if you used `--alias` in step 3 or have more than one org
  logged in to the CLI.
- `SF_CLI_PATH=` the full path from `which sf`, if SF Desk says it can't find the Salesforce CLI.
- `PORT=` another port, if something else already uses 3000.

### 6. Start SF Desk

From Terminal.app, in the project folder:

```bash
npm start
```

You'll see `SF Desk running at http://localhost:3000`. Open that address in your browser and click
**Connect**. Keep the Terminal window open while you use the app; press **Ctrl+C** in it to stop SF Desk.

#### Allow calendar access

The first time you open **Time Entry**, SF Desk builds its calendar reader (`mac/calendar.swift`,
about a minute) and macOS asks whether **Terminal** may access your calendars. Choose **Allow Full
Access**. Then pick your Exchange calendar from the list at the top of the tab if it isn't already
selected.

If you dismissed the prompt or clicked Don't Allow: open **System Settings > Privacy & Security >
Calendars**, turn on **Terminal**, then stop SF Desk with Ctrl+C, run `npm start` again and reload the page.

## Windows

SF Desk for Windows comes as `SF-Desk-windows.zip` for Intel and AMD PCs, or `SF-Desk-windows-arm64.zip` for ARM PCs
(Snapdragon; **Settings > System > About** shows which). You need Windows 10 or 11 (64-bit), Microsoft Edge (built
in) and **classic Outlook** signed in to your SailPoint mailbox; the new Outlook doesn't let other apps read its
calendar, so turn off the **New Outlook** toggle if it's on.

1. Right-click the zip > **Extract All...**, open the extracted folder and double-click **Install SF Desk**.
   If SmartScreen warns, click **More info > Run anyway**. It installs into `%LOCALAPPDATA%\Programs\SF Desk`
   (no admin rights) and adds SF Desk to the Start menu and the Desktop.
2. SF Desk starts. The first time it offers to download the Salesforce CLI (unless one is installed) and opens
   your browser to sign in to `sailpoint.my.salesforce.com`.
3. Click **Connect**, open **Time Entry** and pick your mailbox's **Calendar** at the top. If Outlook asks
   whether to allow a program to access its data, choose **Allow** (this happens when Windows doesn't report
   an up-to-date antivirus).

Closing the window keeps SF Desk running; the SF Desk icon by the clock reopens it and has **Edit Settings...**,
**Restart Server**, **Show Server Log**, **Show Data Folder** and **Quit SF Desk**. Settings and data are in
`%LOCALAPPDATA%\SF Desk`; running **Install SF Desk** from a newer zip updates the app and keeps them.

If Time Entry says PowerShell's policy stops SF Desk from reading Outlook, your PC only allows signed scripts;
ask IT, or use Salesforce events. If it says Outlook and SF Desk run with different permissions, start Outlook
normally (not as administrator).

### Building the Windows download

Anywhere npm and nodejs.org are reachable (e.g. in the cloud), `scripts/build-windows-package.sh` writes
`dist/SF-Desk-windows.zip`; with `--arch arm64` it writes `dist/SF-Desk-windows-arm64.zip`. Running from a Git checkout on Windows also works: `npm start` uses Outlook the
same way, with `sf` from your PATH.

## Optional: the Outlook add-in

SF Desk can also put a **Create Deal Support** button on meetings in Outlook. It needs a one-time HTTPS
certificate and adding the add-in to Outlook. In the Mac app, choose **SF Desk > Set Up Outlook Add-in...**.
Otherwise, in Terminal, in the SF Desk folder (`~/SF-Desk` for the Terminal installer), run `sh scripts/outlook-cert.sh --trust`, restart SF Desk, then follow
[OUTLOOK.md](OUTLOOK.md) from step 2. Updates keep the certificate.

## Where your data lives

Paths are inside `~/Library/Application Support/SF Desk` for the Mac app, `~/SF-Desk` for the Terminal
installer, or your checkout for a manual one.

- `data/sf-desk.db` holds a local copy of the accounts and opportunities you've loaded, your hidden
  records, and which meetings you've logged or marked as not needing a Deal Support. Deleting the
  `data` folder resets all of that; it's rebuilt as you use the app.
- `data/bin/sfdesk-calendar` is the compiled calendar reader (not used by the Mac app, which has its own).
  Delete it to force a rebuild.
- Your Salesforce token is only held in memory and never written to disk. Every edit goes straight to
  Salesforce when you click **Save** or **Add**.
- The server only listens on `localhost`, so nobody else on the network can reach it.

## Updating a manual install

```bash
cd ~/Documents/SF-Desk
git pull
```

Then stop SF Desk with Ctrl+C and run `npm start` again. If the pull changed `package-lock.json`,
redo step 4's dependency step first.

## Troubleshooting

### Time Entry lists no calendars, or only "Salesforce events"

With the SF Desk app, check step 1, then that **SF Desk** is on in **System Settings > Privacy &
Security > Calendars** (quit and reopen the app after turning it on). Steps 2 to 4 are for starting SF
Desk from Terminal or a checkout.

Work through these in order:

1. **Is the Exchange account in Calendar.app?** If your meetings don't show there, go back to step 2.
   Check that **Calendars** is on for the account in Internet Accounts.
2. **Did you start SF Desk from Terminal.app?** (The **Start SF Desk** launcher does.) macOS gives calendar permission to whichever app ran
   `npm start`. Started from VS Code, iTerm, the Claude app or another tool, the permission prompt may
   never appear, or may apply to that app instead. Stop SF Desk, start it from Terminal.app, and reload.
3. **Is Terminal allowed?** In **System Settings > Privacy & Security > Calendars**, Terminal should be
   on. If it's off, turn it on and restart SF Desk. If Terminal isn't listed at all, starting SF Desk
   from Terminal.app and opening Time Entry makes macOS ask.
4. **Did the calendar reader build?** Look in the Terminal window running SF Desk for
   `Couldn't build the calendar helper`. That means the Xcode Command Line Tools are missing or
   broken: run `xcode-select --install`, delete `data/bin`, restart SF Desk. Without the tools SF Desk
   falls back to asking Calendar.app, which needs a separate permission under **Privacy & Security >
   Automation** (Terminal > Calendar).

### macOS says the installer, `node` or `better_sqlite3.node` can't be opened

Files from a browser download are quarantined by macOS. Open the installer with **Open Anyway** as in
the Terminal installer's step 2; it then clears the quarantine on everything it installs. If a dialog still
names a file in `~/SF-Desk`, run `xattr -dr com.apple.quarantine ~/SF-Desk` in Terminal and start
SF Desk again.

### Connect fails, or a message mentions a redacted or missing token

Recent versions of the Salesforce CLI hide the access token in `sf org display` (it shows as
`[REDACTED]`). SF Desk handles this by asking `sf org auth show-access-token` instead, so:

- Update the CLI if it's old: `sf update`, or install the latest `.pkg` again.
- Check the CLI can hand out a token: `sf org auth show-access-token` should print one for your
  SailPoint org (add `--target-org <alias>` if you use an alias).
- If the CLI login has expired, sign in again with the `sf org login web` command in step 3.
- If you have several orgs in the CLI, set `SF_TARGET_ORG` in `.env` to the right one.

### `npm install` fails or hangs

Errors such as `ETIMEDOUT`, `ECONNRESET`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or a Cisco Umbrella block
page mean the npm registry is blocked. Don't fight it: use the `git archive` commands in step 4 to
take `node_modules` from GitHub instead. The same applies to the Salesforce CLI; install it from the
`.pkg`, not npm.

### "Salesforce CLI (sf) not found"

The app couldn't find `sf` on its PATH. Run `which sf` in Terminal and put that full path in `.env` as
`SF_CLI_PATH=`, then restart SF Desk.

### `Cannot find module 'better-sqlite3'` or another missing module

`node_modules` is missing or incomplete. Redo the dependency step in step 4 from the project folder.

### `EADDRINUSE` on port 3000

Another program (or a second copy of SF Desk) is using port 3000. Close it, or set `PORT=3001` in
`.env` and open http://localhost:3001 instead.

### Salesforce says the API isn't enabled for your user

Your Salesforce profile needs the **API Enabled** permission. Ask the Salesforce admins.

For what each tab does and the optional `.env` settings, see the [README](README.md).
