const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const MEMBERS_TAB = 'Members';
const REQUESTS_TAB = 'Requests';
const REQUESTS_HEADERS = [
  'Timestamp', 'Name', 'Member', 'Device', 'Problem',
  'Checked In', 'Status', 'Assigned To', 'Assigned Time', 'Completed Time',
  'Source', 'CE Reg ID'
];

let sheetsClientPromise;

/**
 * Formats a Date as Phoenix-local time (e.g. "8/4/2026, 1:01:41 PM") so the
 * sheet is human-readable instead of showing raw ISO timestamps.
 */
function formatTimestamp(date) {
  return (date || new Date()).toLocaleString('en-US', { timeZone: 'America/Phoenix' });
}

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
      range: `${REQUESTS_TAB}!A1:L1`,
      valueInputOption: 'RAW',
      requestBody: { values: [REQUESTS_HEADERS] }
    });
    return;
  }

  // Tab already exists (e.g. from before Source/CE Reg ID were added) -
  // backfill any missing header columns without touching existing data.
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!A1:L1`
  });
  const currentHeaders = (headerRes.data.values && headerRes.data.values[0]) || [];
  if (currentHeaders.length < REQUESTS_HEADERS.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${REQUESTS_TAB}!A1:L1`,
      valueInputOption: 'RAW',
      requestBody: { values: [REQUESTS_HEADERS] }
    });
  }
}

/**
 * Finds the header row in the Members tab (searching the first several
 * rows, since Club Express exports sometimes have a title/blank row above
 * the real headers) and returns its index plus column positions.
 */
async function findMembersHeaderRow(data) {
  const MAX_HEADER_SCAN_ROWS = 10;
  for (let i = 0; i < Math.min(data.length, MAX_HEADER_SCAN_ROWS); i++) {
    const candidate = data[i].map(h => String(h || '').toLowerCase().trim());
    const fIdx = candidate.indexOf('first name');
    const lIdx = candidate.indexOf('last name');
    const nIdx = candidate.findIndex(h => h === 'name' || h === 'full name');
    if ((fIdx > -1 && lIdx > -1) || nIdx > -1) {
      return { headerRowIndex: i, firstIdx: fIdx, lastIdx: lIdx, nameIdx: nIdx };
    }
  }
  return null;
}

/**
 * Makes sure a tab's physical grid has at least minRows rows, growing it if
 * needed. Google Sheets tabs have a fixed grid size independent of how much
 * data is in them - if rows get deleted (not just cleared), the grid can
 * shrink below what a write needs, causing an "exceeds grid limits" error.
 * This keeps that from ever blocking an import again.
 */
async function ensureSheetHasRows(sheets, tabName, minRows) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties'
  });
  const sheet = meta.data.sheets.find(s => s.properties.title === tabName);
  if (!sheet) return;
  const currentRows = sheet.properties.gridProperties.rowCount;
  if (currentRows < minRows) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          appendDimension: {
            sheetId: sheet.properties.sheetId,
            dimension: 'ROWS',
            length: minRows - currentRows
          }
        }]
      }
    });
  }
}

/**
 * Replaces all member data rows with a fresh list, leaving the header row
 * exactly where it already is. Used for a full weekly overlay from a Club
 * Express member export - not an append, a full replace of the roster.
 * records: array of { first, last } (or { name } for a single full-name column)
 */
async function overlayMembers(records) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: MEMBERS_TAB
  });
  const data = res.data.values || [];
  const headerInfo = await findMembersHeaderRow(data);
  if (!headerInfo) {
    return { success: false, error: 'Could not find a header row (First Name/Last Name or Name) in the Members tab.' };
  }

  const { headerRowIndex, firstIdx, lastIdx, nameIdx } = headerInfo;
  const useFirstLast = firstIdx > -1 && lastIdx > -1;
  const numCols = data[headerRowIndex].length;
  const oldDataRowCount = data.length - (headerRowIndex + 1);
  const rowsToClear = Math.max(oldDataRowCount, records.length);
  const startRow = headerRowIndex + 2; // 1-indexed sheet row right after header

  await ensureSheetHasRows(sheets, MEMBERS_TAB, startRow + rowsToClear - 1);

  if (rowsToClear > 0) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${MEMBERS_TAB}!A${startRow}:${columnLetter(numCols)}${startRow + rowsToClear - 1}`
    });
  }

  if (records.length) {
    const newRows = records.map(r => {
      const row = new Array(numCols).fill('');
      if (useFirstLast) {
        row[firstIdx] = r.first || '';
        row[lastIdx] = r.last || '';
        if (nameIdx > -1) row[nameIdx] = `${r.first || ''} ${r.last || ''}`.trim();
      } else if (nameIdx > -1) {
        row[nameIdx] = r.name || `${r.first || ''} ${r.last || ''}`.trim();
      }
      return row;
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${MEMBERS_TAB}!A${startRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: newRows }
    });
  }

  return { success: true, memberCount: records.length };
}

function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
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

  // Club Express exports sometimes have extra title/blank rows before the
  // real header row, so search the first several rows for the one that
  // actually contains "first name" / "last name" (or "name" / "full name")
  // instead of assuming row 1 is the header.
  const MAX_HEADER_SCAN_ROWS = 10;
  let headerRowIndex = -1;
  let firstIdx = -1, lastIdx = -1, nameIdx = -1;

  for (let i = 0; i < Math.min(data.length, MAX_HEADER_SCAN_ROWS); i++) {
    const candidate = data[i].map(h => String(h || '').toLowerCase().trim());
    const fIdx = candidate.indexOf('first name');
    const lIdx = candidate.indexOf('last name');
    const nIdx = candidate.findIndex(h => h === 'name' || h === 'full name');
    if ((fIdx > -1 && lIdx > -1) || nIdx > -1) {
      headerRowIndex = i;
      firstIdx = fIdx;
      lastIdx = lIdx;
      nameIdx = nIdx;
      break;
    }
  }

  if (headerRowIndex === -1) return [];

  const names = [];
  for (let i = headerRowIndex + 1; i < data.length; i++) {
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
    range: `${REQUESTS_TAB}!A:L`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        formatTimestamp(), name, member ? 'Yes' : 'No', device, problem,
        'Yes', 'Not Assigned', '', '', '', 'Walk-in', ''
      ]]
    }
  });

  return { success: true, member };
}

/**
 * Imports pre-registered requests pulled from a Club Express CSV export.
 * Each record: { name, device, problem, ceRegId, timestamp }
 * Skips any record whose ceRegId already exists in the sheet, so the same
 * weekly export can be re-uploaded safely without creating duplicates.
 */
async function importPreRegistrations(records) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!L:L`
  });
  const existingIds = new Set((res.data.values || []).map(r => String(r[0] || '').trim()).filter(Boolean));

  const memberNames = await getMemberNames();
  const memberSet = new Set(memberNames.map(n => n.toLowerCase().replace(/\s+/g, ' ').trim()));

  const rowsToAdd = [];
  let skipped = 0;

  for (const rec of records) {
    const ceRegId = String(rec.ceRegId || '').trim();
    if (ceRegId && existingIds.has(ceRegId)) { skipped++; continue; }

    const name = String(rec.name || '').trim();
    const device = String(rec.device || '').trim();
    const problem = String(rec.problem || '').trim();
    if (!name || !device || !problem) { skipped++; continue; }

    const isMemberMatch = memberSet.has(name.toLowerCase().replace(/\s+/g, ' ').trim());
    rowsToAdd.push([
      rec.timestamp || formatTimestamp(), name, isMemberMatch ? 'Yes' : 'No', device, problem,
      'No', 'Not Assigned', '', '', '', 'Pre-registered', ceRegId
    ]);
    if (ceRegId) existingIds.add(ceRegId);
  }

  if (rowsToAdd.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${REQUESTS_TAB}!A:L`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rowsToAdd }
    });
  }

  return { success: true, imported: rowsToAdd.length, skipped };
}

/**
 * Finds pre-registered requests that haven't been checked in yet, matching
 * on a partial, case-insensitive name search - used by the front desk to
 * locate a pre-registered member when they arrive.
 */
async function findPendingCheckIns(nameQuery) {
  const query = String(nameQuery || '').toLowerCase().trim();
  if (!query) return [];
  const all = await getRequests();
  return all.filter(r =>
    r.source === 'Pre-registered' &&
    r.checkedIn !== 'Yes' &&
    r.name.toLowerCase().includes(query)
  );
}

/**
 * Flips a pre-registered request's Checked In status to Yes when the
 * member physically arrives at the club.
 */
async function checkInExisting(row) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!F${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Yes']] }
  });
  return { success: true };
}

/**
 * True if a pre-registered request is a no-show from a past week's event -
 * never checked in, and dated before the most recent Tuesday. These age
 * off the live dashboard on their own once their event date has passed,
 * instead of lingering forever until someone remembers to mark them
 * Completed by hand. This only affects what the dashboard shows - the row
 * itself is untouched in the Sheet, so it's still there for reporting.
 */
function isStalePreRegistration(row) {
  if (row.source !== 'Pre-registered' || row.checkedIn === 'Yes') return false;

  const match = String(row.timestamp || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return false; // can't tell the date - don't hide it

  const [, month, day, year] = match;
  const rowDateUtc = Date.UTC(Number(year), Number(month) - 1, Number(day));

  const phoenixParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).formatToParts(new Date());
  const get = type => phoenixParts.find(p => p.type === type).value;
  const todayUtc = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')));
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const daysSinceTuesday = (dowMap[get('weekday')] - 2 + 7) % 7;
  const mostRecentTuesdayUtc = todayUtc - daysSinceTuesday * 24 * 60 * 60 * 1000;

  return rowDateUtc < mostRecentTuesdayUtc;
}

async function getRequests() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!A:L`
  });
  const data = res.data.values || [];
  const results = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[6];
    if (status === 'Completed') continue;
    if (!row[1]) continue; // skip blank rows

    const record = {
      row: i + 1, // 1-indexed sheet row
      timestamp: row[0],
      name: row[1],
      member: row[2],
      device: row[3],
      problem: row[4],
      checkedIn: row[5],
      status: status,
      assignedTo: row[7],
      source: row[10] || 'Walk-in'
    };
    if (isStalePreRegistration(record)) continue;
    results.push(record);
  }
  return results;
}

/**
 * Returns every row in the Requests tab, unfiltered - used by the walk-in
 * reporting export, which (unlike the live dashboard) needs completed
 * requests too, not just the ones still open.
 */
async function getAllRequests() {
  const sheets = await getSheetsClient();
  // UNFORMATTED_VALUE + SERIAL_NUMBER returns real date/time cells as a
  // raw Sheets serial number instead of whatever text the cell's display
  // format happens to produce - the walk-in export depends on parsing
  // this reliably, and cell formatting has proven too fragile to trust
  // (a stray space in a custom format was enough to blank out every
  // date). Plain-text timestamp cells (the normal case, written by the
  // live app) are returned unchanged either way.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!A:L`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  const data = res.data.values || [];
  const results = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[1]) continue; // skip blank rows

    results.push({
      timestamp: row[0],
      name: row[1],
      member: row[2],
      device: row[3],
      problem: row[4],
      checkedIn: row[5],
      status: row[6],
      assignedTo: row[7],
      assignedTime: row[8],
      completedTime: row[9],
      source: row[10] || 'Walk-in',
      ceRegId: row[11]
    });
  }
  return results;
}

async function claimRequest(row) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!G${row}:I${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Assigned', '', formatTimestamp()]] }
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
        { range: `${REQUESTS_TAB}!J${row}`, values: [[formatTimestamp()]] }
      ]
    }
  });
  return { success: true };
}

/**
 * Marks every still-open request (anything not already Completed) as
 * Completed, leaving Assigned To/Assigned Time untouched. Run at the end
 * of each Tech Help session so a ticket nobody clicked "Done" on doesn't
 * linger on the live dashboard into the following week.
 */
async function completeAllOpenRequests() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${REQUESTS_TAB}!A:L`
  });
  const data = res.data.values || [];
  const now = formatTimestamp();
  const updates = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[1]) continue; // skip blank rows
    if (row[6] === 'Completed') continue;

    const sheetRow = i + 1;
    updates.push({ range: `${REQUESTS_TAB}!G${sheetRow}`, values: [['Completed']] });
    updates.push({ range: `${REQUESTS_TAB}!J${sheetRow}`, values: [[now]] });
  }

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: updates }
    });
  }

  return { success: true, completed: updates.length / 2 };
}

module.exports = {
  ensureRequestsTab,
  getMemberNames,
  addRequest,
  getRequests,
  getAllRequests,
  claimRequest,
  unclaimRequest,
  completeRequest,
  completeAllOpenRequests,
  importPreRegistrations,
  findPendingCheckIns,
  checkInExisting,
  overlayMembers
};
