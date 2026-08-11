const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const MEMBERS_TAB = 'Members';
const REQUESTS_TAB = 'Requests';
const REQUESTS_HEADERS = [
  'Timestamp', 'Name', 'Member', 'Device', 'Problem',
  'Checked In', 'Status', 'Assigned To', 'Assigned Time', 'Completed Time'
];

let sheetsClientPromise;

function getSheetsClient() {
  if (!sheetsClientPromise) {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set.');
    }
    if (!SPREADSHEET_ID) {
      throw new Error('SPREADSHEET_ID environment variable is not set.');
    }
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsClientPromise = Promise.resolve(google.sheets({ version: 'v4', auth }));
  }
  return sheetsClientPromise;
}

/**
 * Makes sure the Requests tab exists with the right headers.
 * Runs once at startup; safe to call repeatedly.
 */
async function ensureRequestsTab() {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === REQUESTS_TAB);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: REQUESTS_TAB } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${REQUESTS_TAB}!A1:J1`,
      valueInputOption: 'RAW',
      requestBody: { values: [REQUESTS_HEADERS] }
    });
  }
}

// ---------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------

async function getMemberNames() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: MEMBERS_TAB
  });
  const data = res.data.values || [];
  if (data.length < 2) return [];

  const headers = data[0].map(h => String(h || '').toLowerCase().trim());
  const firstIdx = headers.indexOf('first name');
  const lastIdx = headers.indexOf('last name');
  const nameIdx = headers.findIndex(h => h === 'name' || h === 'full name');

  const names = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    let full = '';
    if (firstIdx > -1 && lastIdx > -1) {
      full = `${row[firstIdx] || ''} ${row[lastIdx] || ''}`.trim();
    } else if (nameIdx > -1) {
      full = String(row[nameIdx] || '').trim();
    }
    if (full) names.push(full);
  }
  return names;
}

async function isMember(name) {
  const target = String(name).toLowerCase().replace(/\s+/g, ' ').trim();
  const names = await getMemberNames();
  return names.some(n => n.toLowerCase().replace(/\s+/g, ' ').trim() === target);
}

// ---------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------

async function addRequest(name, device, problem) {
  name = String(name || '').trim();
  device = String(device || '').trim();
  problem = String(problem || '').trim();
  if (!name || !device || !problem) {
    return { success: false, error: 'Missing name, device, or problem description.' };
  }

  const member = await isMember(name);
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!A:J`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        new Date().toISOString(), name, member ? 'Yes' : 'No', device, problem,
        'Yes', 'Not Assigned', '', '', ''
      ]]
    }
  });

  return { success: true, member };
}

async function getRequests() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!A:J`
  });
  const data = res.data.values || [];
  const results = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[6];
    if (status === 'Completed') continue;
    if (!row[1]) continue; // skip blank rows

    results.push({
      row: i + 1, // 1-indexed sheet row
      timestamp: row[0],
      name: row[1],
      member: row[2],
      device: row[3],
      problem: row[4],
      checkedIn: row[5],
      status: status,
      assignedTo: row[7]
    });
  }
  return results;
}

async function claimRequest(row, helperName) {
  helperName = String(helperName || '').trim();
  if (!helperName) return { success: false, error: 'Helper name required.' };
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!G${row}:I${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Assigned', helperName, new Date().toISOString()]] }
  });
  return { success: true };
}

async function unclaimRequest(row) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!G${row}:I${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Not Assigned', '', '']] }
  });
  return { success: true };
}

async function completeRequest(row) {
  const sheets = await getSheetsClient();
  // Two separate single-cell updates so Assigned To (H) and Assigned Time (I) are left untouched.
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${REQUESTS_TAB}!G${row}`, values: [['Completed']] },
        { range: `${REQUESTS_TAB}!J${row}`, values: [[new Date().toISOString()]] }
      ]
    }
  });
  return { success: true };
}

module.exports = {
  ensureRequestsTab,
  getMemberNames,
  addRequest,
  getRequests,
  claimRequest,
  unclaimRequest,
  completeRequest
};
