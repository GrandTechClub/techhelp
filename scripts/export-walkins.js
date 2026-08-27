// Runs weekly via GitHub Actions (Tuesday 5pm Phoenix time). Pulls every
// Walk-in request ever recorded in the Requests tab, reshapes it to match
// the Reports.Tech_Help_Issues table, and emails it as a CSV attachment to
// the same Gmail inbox the SQL Server side already watches for report
// files.
//
// Pre-registered rows are intentionally excluded - those already flow into
// the reporting database through the existing Club Express -> Exago -> ETL
// pipeline, so including them here would double-count them.
//
// This exports the FULL walk-in history every run, not just the latest
// Tuesday's rows. The SQL Server side truncates and fully reloads its
// staging table from whatever CSV it finds, so a partial export would wipe
// out every earlier week's data on the next load.

const { google } = require('googleapis');
const { getAllRequests } = require('../sheets');

const {
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN
} = process.env;

const RECIPIENT = 'gtcclubexpressimport@gmail.com';
// TODO: confirm this against whatever the SQL Server "Load All Exago
// Tables" step and the updated email_download_3.py end up matching on.
const SUBJECT = 'TechHelp Walkins Report';
// TODO: confirm this against the BULK INSERT file path in the "Load All
// Exago Tables" job - it likely expects a fixed filename, not a dated one.
const FILENAME = 'TechHelp_Walkins.csv';

function requireEnv() {
  const missing = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'SPREADSHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error('Missing required environment variables: ' + missing.join(', '));
  }
}

function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Converts the Sheet's "8/4/2026, 1:01:41 PM" (Phoenix wall-clock string)
// into "2026-08-04 13:01:41" for an unambiguous SQL Server import. This is
// deliberately string parsing, not a round-trip through Date - the
// runner's own timezone (UTC on GitHub Actions) would otherwise
// reinterpret the string and shift the time by 7 hours.
function toSqlDateTime(raw) {
  const m = String(raw || '').trim().match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i
  );
  if (!m) return '';
  let [, month, day, year, hour, minute, second, ampm] = m;
  hour = parseInt(hour, 10);
  if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
  const pad = n => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${minute}:${second}`;
}

function csvField(value) {
  const str = String(value == null ? '' : value);
  return `"${str.replace(/"/g, '""')}"`;
}

function buildCsv(rows) {
  const headers = ['StartDateTime', 'Attended', 'RegistrationDate', 'FullName', 'Answer', 'QuestionName'];
  const lines = [headers.map(csvField).join(',')];
  for (const r of rows) {
    lines.push([r.StartDateTime, r.Attended, r.RegistrationDate, r.FullName, r.Answer, r.QuestionName].map(csvField).join(','));
  }
  return lines.join('\r\n');
}

async function buildWalkinRows() {
  const all = await getAllRequests();
  const walkins = all.filter(r => r.source === 'Walk-in');

  const seen = new Set();
  const rows = [];
  for (const r of walkins) {
    const startDateTime = toSqlDateTime(r.timestamp);
    const row = {
      StartDateTime: startDateTime,
      Attended: 'Yes',
      RegistrationDate: startDateTime,
      FullName: String(r.name || '').trim(),
      Answer: String(r.device || '').trim(),
      QuestionName: String(r.problem || '').trim()
    };
    const key = JSON.stringify(row);
    if (seen.has(key)) continue; // drop true duplicates (e.g. an accidental double-submit)
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

function buildRawEmail(csvContent) {
  const boundary = 'techhelp_walkins_boundary';
  const messageParts = [
    `From: ${RECIPIENT}`,
    `To: ${RECIPIENT}`,
    `Subject: ${SUBJECT}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Automated weekly export of Tech Help walk-in requests. See attached CSV.',
    '',
    `--${boundary}`,
    `Content-Type: text/csv; name="${FILENAME}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${FILENAME}"`,
    '',
    Buffer.from(csvContent, 'utf8').toString('base64'),
    '',
    `--${boundary}--`
  ];
  const message = messageParts.join('\r\n');
  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function main() {
  requireEnv();

  const rows = await buildWalkinRows();
  console.log(`Found ${rows.length} walk-in row(s) to export.`);
  if (!rows.length) {
    console.log('Nothing to export - skipping email.');
    return;
  }

  const csvContent = buildCsv(rows);
  const gmail = getGmailClient();
  const raw = buildRawEmail(csvContent);
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

  console.log(`Sent ${FILENAME} (${rows.length} rows) to ${RECIPIENT}.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
