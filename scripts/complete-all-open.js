// Runs weekly via GitHub Actions (Tuesday ~5pm Phoenix time, right around
// when Tech Help wraps up). Marks every request still open on the
// dashboard as Completed, so a ticket nobody clicked "Done" on doesn't
// linger into the following week's queue.

const { completeAllOpenRequests } = require('../sheets');

function requireEnv() {
  const missing = ['SPREADSHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error('Missing required environment variables: ' + missing.join(', '));
  }
}

async function main() {
  requireEnv();
  const result = await completeAllOpenRequests();
  console.log(`Marked ${result.completed} open request(s) as Completed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
