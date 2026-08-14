const express = require('express');
const path = require('path');
const {
  ensureRequestsTab,
  getMemberNames,
  addRequest,
  getRequests,
  claimRequest,
  unclaimRequest,
  completeRequest,
  importPreRegistrations,
  findPendingCheckIns,
  checkInExisting,
  overlayMembers
} = require('./sheets');
const { parsePreRegistrationCsv, parseMembersCsv } = require('./csv-import');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight protection for the import endpoints, which are now called
// both from the browser (staff uploads) and from an automated script.
// If IMPORT_API_KEY isn't set on Render, this is skipped entirely - set
// it once automation is wired up to stop random requests from reaching
// these endpoints.
function requireImportKey(req, res, next) {
  const configuredKey = process.env.IMPORT_API_KEY;
  if (!configuredKey) return next();
  const providedKey = req.headers['x-import-key'];
  if (providedKey !== configuredKey) {
    return res.status(401).json({ success: false, error: 'Invalid or missing import key.' });
  }
  next();
}

// ---- pages ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
});
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/import', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'import.html'));
});

// ---- API ----
app.get('/api/members', async (req, res) => {
  try {
    res.json(await getMemberNames());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/checkin', async (req, res) => {
  try {
    const { name, device, problem } = req.body;
    res.json(await addRequest(name, device, problem));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/requests', async (req, res) => {
  try {
    res.json(await getRequests());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claim', async (req, res) => {
  try {
    const { row, helperName } = req.body;
    res.json(await claimRequest(row, helperName));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/unclaim', async (req, res) => {
  try {
    const { row } = req.body;
    res.json(await unclaimRequest(row));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/complete', async (req, res) => {
  try {
    const { row } = req.body;
    res.json(await completeRequest(row));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/import-preregistrations', requireImportKey, async (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv || typeof csv !== 'string') {
      return res.status(400).json({ success: false, error: 'No CSV text provided.' });
    }
    const parsed = parsePreRegistrationCsv(csv);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    res.json(await importPreRegistrations(parsed.records));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/pending', async (req, res) => {
  try {
    const { name } = req.query;
    res.json(await findPendingCheckIns(name));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/checkin-existing', async (req, res) => {
  try {
    const { row } = req.body;
    res.json(await checkInExisting(row));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/import-members', requireImportKey, async (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv || typeof csv !== 'string') {
      return res.status(400).json({ success: false, error: 'No CSV text provided.' });
    }
    const parsed = parseMembersCsv(csv);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    res.json(await overlayMembers(parsed.records));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

// Catches errors thrown by middleware (like body-parser rejecting an
// oversized request) or any route that didn't handle its own error, and
// returns clean JSON instead of Express's default HTML error page - which
// would otherwise break every front-end fetch() call expecting JSON back.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'File is too large to upload.' });
  }
  res.status(err.status || 500).json({ success: false, error: err.message || 'Unexpected server error.' });
});

ensureRequestsTab()
  .then(() => {
    app.listen(PORT, () => console.log(`Tech Help running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize Google Sheet:', err.message);
    process.exit(1);
  });
