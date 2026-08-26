# Privacy Policy — TechHelp Club Express Import

This app is an internal tool for the Grand Tech Club's Tech Help program. It
is not a public product and is not used by the general public.

## What it accesses

A single, dedicated Gmail inbox (`gtcclubexpressimport@gmail.com`) is used to
receive two scheduled reports exported from Club Express: a member list and a
list of Tech Help pre-registrations.

The import script connects to this inbox via the Gmail API to:

- Search for unread emails with a specific subject line
- Download the CSV attachment from those emails
- Move the email to Trash once its data has been imported

No emails are read, modified, or deleted other than the specific scheduled
report emails matching these subject lines. No other Gmail data (contacts,
other messages, drafts, etc.) is accessed.

## What happens to the data

The CSV data (member names and Tech Help sign-up details) is imported into a
private Google Sheet used to run the club's Tech Help check-in queue. It is
not shared with any third party and is not used for any purpose beyond
operating the Tech Help program.

## Contact

Questions about this tool can be directed to carol.gontko@gmail.com.
