// Runs on a schedule via GitHub Actions. Checks the dedicated Gmail inbox
// for unread Club Express report emails, downloads the CSV attachment,
// and posts it to the same import endpoints the manual /import page uses.
// Marks each email as read once handled, so it's never processed twice.

const { google } = require('googleapis');

const RENDER_BASE_URL = (process.env.RENDER_BASE_URL || '').replace(/\/+$/, '');
const {
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN,
  RENDER_IMPORT_API_KEY
} = process.env;

// Subject line -> which endpoint to import into. Set these exact subject
// lines on the two scheduled reports in Club Express.
const ROUTES = [
  { subject: 'TechHelp Members Report', endpoint: '/api/import-members', label: 'Members' },
  { subject: 'TechHelp PreReg Report', endpoint: '/api/import-preregistrations', label: 'Pre-Registrations' }
];

function requireEnv() {
  const missing = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'RENDER_BASE_URL']
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

function decodeBase64Url(data) {
  return Buffer.from(data, 'base64').toString('utf8');
}

function findCsvAttachmentPart(payload) {
  const parts = payload.parts || [];
  for (const part of parts) {
    const filename = part.filename || '';
    if (filename.toLowerCase().endsWith('.csv') && part.body && part.body.attachmentId) {
      return part;
    }
    if (part.parts) {
      const nested = findCsvAttachmentPart(part);
      if (nested) return nested;
    }
  }
  return null;
}

async function processMessage(gmail, message, route) {
  const full = await gmail.users.messages.get({ userId: 'me', id: message.id, format: 'full' });
  const attachmentPart = findCsvAttachmentPart(full.data.payload);

  if (!attachmentPart) {
    console.warn(`[${route.label}] No CSV attachment found on message ${message.id} - leaving unread for review.`);
    return { imported: false };
  }

  const attachment = await gmail.users.messages.attachments.get({
    userId: 'me', messageId: message.id, id: attachmentPart.body.attachmentId
  });
  const csvText = decodeBase64Url(attachment.data.data.replace(/-/g, '+').replace(/_/g, '/'));

  const resp = await fetch(`${RENDER_BASE_URL}${route.endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(RENDER_IMPORT_API_KEY ? { 'x-import-key': RENDER_IMPORT_API_KEY } : {})
    },
    body: JSON.stringify({ csv: csvText })
  });

  const rawBody = await resp.text();
  let result;
  try {
    result = JSON.parse(rawBody);
  } catch (parseErr) {
    console.error(`[${route.label}] Server returned a non-JSON response (HTTP ${resp.status}) for message ${message.id}. First 200 chars: ${rawBody.slice(0, 200)}`);
    return { imported: false };
  }

  if (!result.success) {
    console.error(`[${route.label}] Import failed for message ${message.id}:`, result.error);
    return { imported: false };
  }

  console.log(`[${route.label}] Imported message ${message.id}:`, JSON.stringify(result));

  // Move to Trash so it's not reprocessed next run. Gmail keeps trashed
  // items for 30 days before permanently deleting them, so this is safely
  // recoverable if something ever needs a second look.
  await gmail.users.messages.trash({ userId: 'me', id: message.id });

  return { imported: true };
}

async function main() {
  requireEnv();
  const gmail = getGmailClient();
  let totalImported = 0;

  for (const route of ROUTES) {
    const query = `is:unread has:attachment subject:"${route.subject}"`;
    const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 10 });
    const messages = list.data.messages || [];

    if (!messages.length) {
      console.log(`[${route.label}] No unread report emails found.`);
      continue;
    }

    for (const message of messages) {
      const result = await processMessage(gmail, message, route);
      if (result.imported) totalImported++;
    }
  }

  console.log(`Done. ${totalImported} report(s) imported.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
