// Parses the weekly "Tech Help" pre-registration report exported from Club
// Express as CSV, and turns it into the record shape importPreRegistrations()
// expects: { name, device, problem, ceRegId, timestamp }
//
// The export has a title row, then a header row with columns like:
//   Assigned to Tech Team | Checked In Order | Time | Name (Last, First) |
//   Checked in at the Club | Tech Devices | Tech Issue
// Column order and exact wording can shift between exports, so headers are
// matched by keyword rather than fixed position.

function parseCsvLines(text) {
  // Minimal CSV parser that handles quoted fields containing commas.
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => String(cell || '').trim() !== ''));
}

function reformatName(raw) {
  // "Last, First" -> "First Last". Leaves already-normal names untouched.
  const str = String(raw || '').trim();
  const commaIdx = str.indexOf(',');
  if (commaIdx === -1) return str;
  const last = str.slice(0, commaIdx).trim();
  const first = str.slice(commaIdx + 1).trim();
  return `${first} ${last}`.trim();
}

function parsePreRegistrationCsv(text) {
  const rows = parseCsvLines(text);
  const MAX_HEADER_SCAN_ROWS = 10;
  let headerRowIndex = -1;
  let nameIdx = -1, deviceIdx = -1, problemIdx = -1, timeIdx = -1, orderIdx = -1;

  for (let i = 0; i < Math.min(rows.length, MAX_HEADER_SCAN_ROWS); i++) {
    const candidate = rows[i].map(h => String(h || '').toLowerCase().trim());
    const nIdx = candidate.findIndex(h => h.includes('name'));
    const dIdx = candidate.findIndex(h => h.includes('device'));
    const pIdx = candidate.findIndex(h => h.includes('issue') || h.includes('problem'));
    if (nIdx > -1 && dIdx > -1 && pIdx > -1) {
      headerRowIndex = i;
      nameIdx = nIdx; deviceIdx = dIdx; problemIdx = pIdx;
      timeIdx = candidate.findIndex(h => h === 'time' || h.includes('time'));
      orderIdx = candidate.findIndex(h => h.includes('order'));
      break;
    }
  }

  if (headerRowIndex === -1) {
    return { error: 'Could not find a header row with Name, Tech Devices, and Tech Issue columns.' };
  }

  const records = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = reformatName(row[nameIdx]);
    const device = String(row[deviceIdx] || '').trim();
    const problem = String(row[problemIdx] || '').trim();
    if (!name || !device || !problem) continue;

    const time = timeIdx > -1 ? String(row[timeIdx] || '').trim() : '';
    const order = orderIdx > -1 ? String(row[orderIdx] || '').trim() : '';
    // Dedupe key: same person + same registered time is treated as the same
    // registration, so re-uploading the same weekly export is always safe.
    const ceRegId = `${name}|${time || order}`;

    records.push({ name, device, problem, ceRegId, timestamp: time || undefined });
  }

  return { records };
}

module.exports = { parsePreRegistrationCsv, reformatName };
