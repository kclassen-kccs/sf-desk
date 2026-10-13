# Installing SF Desk

SF Desk runs on your Mac and signs in to Salesforce as you, so it only sees and changes what your own
Salesforce user can.

## Before you start

- A Mac on macOS 13 (Ventura) or newer.
- A Salesforce login to `sailpoint.my.salesforce.com` (your usual SSO login).
- Your SailPoint calendar on the Mac. In **System Settings > Internet Accounts**, add your SailPoint
  Exchange account if it isn't there (**Add Account... > Microsoft Exchange**, sign in with your SailPoint
  email) and turn on **Calendars**. Check that this week's meetings show in Calendar.app.

## Install

1. **Drag SF Desk onto the Applications folder** in this window, then eject the disk image.
2. **Open SF Desk from Applications.** The app isn't signed by Apple, so the first time macOS says it can't
   verify the developer. Click **Done**, open **System Settings > Privacy & Security**, scroll down, click
   **Open Anyway** next to "SF Desk" and confirm with your password. You only do this once per new version.
3. **Follow its prompts.** The first time, SF Desk:
   - offers to download the Salesforce CLI, which it signs in with (no admin rights needed);
   - opens your browser to sign in to Salesforce with SSO. Sign in, then come back to SF Desk;
   - offers to set up the Outlook add-in. See **Outlook Add-in** in this window.
4. **Click Connect**, then open **Time Entry**. When macOS asks whether **SF Desk** may access your
   calendars, choose **Allow Full Access**.

Right-click SF Desk in the Dock and choose **Options > Keep in Dock**. Closing its window keeps it running
for the Outlook add-in; quit it to stop it.

To update, drag the new SF Desk onto Applications and replace the old one. Your settings and data are kept.

For what each tab does, see **About SF Desk** in this window.
