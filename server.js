const express = require('express');
const path = require('path');
const {
  ensureRequestsTab,
  getMemberNames,
  addRequest,
  getRequests,
  claimRequest,
  unclaimRequest,
  completeRequest
} = require('./sheets');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- pages ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkin.html'));
});
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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

const PORT = process.env.PORT || 3000;

ensureRequestsTab()
  .then(() => {
    app.listen(PORT, () => console.log(`Backup Tech Help running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize Google Sheet:', err.message);
    process.exit(1);
  });
