# Day 8 — Google Sheets Setup Guide

Follow these steps on the **shared clan Google account**.

---

## Step 1 — Create the Google Sheet

1. Go to **sheets.google.com** and sign in to the **clan account**.
2. Click **Blank spreadsheet**.
3. Rename it: click "Untitled spreadsheet" at the top → type **`69 Chest Tracker Data`** → press Enter.
4. In the tab at the bottom, rename "Sheet1" to **`AppData`**:
   - Right-click the tab → Rename → type `AppData` → Enter.
5. Leave the sheet otherwise empty (the app will write to it automatically).

---

## Step 2 — Open the Apps Script editor

1. In the Google Sheet menu bar, click **Extensions → Apps Script**.
2. A new tab opens — you'll see a code editor with a default `myFunction()` snippet.
3. **Select all** the existing code and **delete it**.

---

## Step 3 — Paste the backend code

1. Open the file **`AppScript_Backend.js`** from your ChestTracker69 folder.
2. Copy all its contents.
3. Paste it into the Apps Script editor (replacing the empty editor).
4. Click the **Save** button (floppy disk icon, or Ctrl+S / Cmd+S).
5. Name the project **`69ChestTracker`** when prompted → click OK.

---

## Step 4 — Deploy as a Web App

1. In the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear icon ⚙️ next to "Select type" → choose **Web app**.
3. Fill in the settings:
   - **Description:** `69 Chest Tracker API`
   - **Execute as:** `Me` (the clan account)
   - **Who has access:** `Anyone`
4. Click **Deploy**.
5. If prompted to authorise, click **Authorise access** → choose the clan Google account → click **Allow**.
6. After deploying, you'll see a **Web app URL** — it looks like:
   ```
   https://script.google.com/macros/s/AKfycb.../exec
   ```
7. **Copy that URL** — you need it in Step 5.

---

## Step 5 — Connect the URL to the app

1. Open **`69ChestTracker.html`** in a text editor (e.g. Notepad, TextEdit, VS Code).
2. Find this line near the top of the script section:
   ```
   const SHEETS_URL = "YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";
   ```
3. Replace `YOUR_APPS_SCRIPT_WEB_APP_URL_HERE` with the URL you copied, keeping the quotes:
   ```
   const SHEETS_URL = "https://script.google.com/macros/s/AKfycb.../exec";
   ```
4. Save the file.

---

## Step 6 — Test locally before re-publishing

1. Open the saved `69ChestTracker.html` file directly in Chrome.
2. Open DevTools (F12) → Console tab.
3. The app should show "Loading clan data…" briefly, then load.
4. Add a test player, then refresh the page — the player should still be there.
5. Check the Google Sheet: you should see JSON data in cell **AppData!A1**.

---

## Step 7 — Re-publish to Netlify

1. Drag the updated `69ChestTracker.html` onto **app.netlify.com/drop**.
2. Netlify will update your existing site automatically if you drop it on the same site, or create a new URL.

   > **Tip:** To update the *same* URL: log into Netlify, go to your site → Deploys → drag the file onto the deploy dropzone.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not reach Google Sheets" banner | Check the URL is pasted correctly with no spaces. Make sure the deployment is set to "Anyone" access. |
| Authorisation popup keeps appearing | Re-deploy: Extensions → Apps Script → Deploy → Manage deployments → create a new version. |
| Data not saving | Open DevTools Console — look for "Sheets save failed" errors. |
| Sheet shows garbled data | Don't edit cell A1 manually — the app manages it. |

---

## How data is stored

All app data lives in a single JSON string in cell **AppData!A1** of your Google Sheet.
You can view it, but don't edit it by hand. Use the app's **Export Backup** function in Admin to get a readable JSON file at any time.
