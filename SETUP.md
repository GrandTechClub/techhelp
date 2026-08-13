# Tech Help — Setup Guide (Node + Google Sheets)

This app lives on GitHub like Lectern. It's a small Node.js/Express app
that serves two pages — Check-In and Dashboard — and reads/writes a Google
Sheet using a service account (no Apps Script, no IP whitelisting).

## 1. Create the Google Sheet

1. Create a new Google Sheet, e.g. **"Tech Help Backend"**.
2. Rename the first tab to **`Members`**.
3. Paste your exported member list in, with headers in row 1:
   either `First Name` + `Last Name` columns, or a single `Name` /
   `Full Name` column.
4. Leave it at that — a `Requests` tab is created automatically the first
   time the app starts up.
5. Copy the **Spreadsheet ID** out of the sheet's URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

## 2. Create a Google Service Account (one-time)

This lets the app read/write the Sheet without any user needing to log in,
and without exposing anything to the public internet.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create
   a project (or reuse one) — free tier is plenty for this.
2. **APIs & Services → Library** → search "Google Sheets API" → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → Service account**.
   Give it any name (e.g. `tech-help-bot`). No special roles needed.
4. Open the new service account → **Keys → Add Key → Create new key → JSON**.
   This downloads a `.json` file — keep it private, never commit it to GitHub.
5. Open that JSON file and copy the `client_email` value (looks like
   `tech-help-bot@your-project.iam.gserviceaccount.com`).
6. Back in your Google Sheet, click **Share**, paste that email in, give it
   **Editor** access.

## 3. Push the code to GitHub

1. Create a new GitHub repo (private is fine), e.g. `techhelp`.
2. Add all the files provided (`server.js`, `sheets.js`, `package.json`,
   `public/checkin.html`, `public/dashboard.html`, `.gitignore`,
   `.env.example`).
3. Double-check `.env` is **not** committed — only `.env.example` should be.

## 4. Deploy (Render example — adjust for Railway/Fly.io/whatever Lectern uses)

1. Sign into [render.com](https://render.com), **New → Web Service**, connect
   your GitHub repo.
2. Build command: `npm install`
   Start command: `npm start`
3. Under **Environment**, add:
   - `SPREADSHEET_ID` — the ID from step 1.
   - `GOOGLE_SERVICE_ACCOUNT_KEY` — paste the **entire contents** of the
     JSON key file from step 2, as one line.
4. Deploy. Render gives you a URL like `https://techhelp.onrender.com`.
   - Check-In page: that URL directly.
   - Dashboard page: same URL + `/dashboard`.

If Lectern is hosted somewhere else (Railway, Fly.io, a VPS), the app itself
doesn't change at all — only steps 4.1–4.3 differ slightly. Let me know which
one and I'll write the exact equivalent steps/config file (e.g. `railway.json`
or a `Dockerfile`).

## 5. Re-deploying after edits

Push to GitHub — most of these platforms (including Render) auto-redeploy on
push to your main branch. No manual redeploy step needed, unlike Apps Script.

## Day-to-day use

- Check-in staff use the Check-In URL: type name (autocompletes against
  `Members`), pick device, describe problem, submit.
- Tech Helpers watch the Dashboard URL (put it on the room's screen) — it
  refreshes itself every 4 seconds.
- **Claim** asks the helper's name and flips the row to Assigned. **Done**
  completes it and drops it off the dashboard. **Unclaim** reverses a
  mistaken claim.
- All of this is still just rows in your Google Sheet under the `Requests`
  tab — nothing gets deleted, so it doubles as your event log.

## Syncing to SQL Server (manual, on your terms)

Whenever your volunteer wants to load data into SQL Server:

1. Open the Google Sheet, go to the `Requests` tab.
2. **File → Download → Comma Separated Values (.csv)**.
3. Import that CSV into SQL Server however they normally would (SSMS Import
   Wizard, `BULK INSERT`, etc.) — entirely on the SQL Server's own network,
   nothing needs to reach out to it.

Same idea in reverse for Members: whenever you pull a fresh Club Express
export, just clear and re-paste the `Members` tab. No code changes needed
either direction.

## Notes

- **Refresh rate**: `REFRESH_MS` in `public/dashboard.html` is 4000ms;
  drop to 3000 if you want, the Sheets API quota (300 requests/min per
  project) handles that easily at club scale.
- **Multiple check-in stations**: fine — the Sheets API serializes appends,
  no double-booking risk.
- **Costs**: Render's free tier works for this traffic level, but free
  services sleep after inactivity and take ~30–60 seconds to wake up on the
  first request of the day. If that matters for your event start time, a
  $7/mo "always on" tier avoids it — worth flagging to whoever owns the
  budget decision.
