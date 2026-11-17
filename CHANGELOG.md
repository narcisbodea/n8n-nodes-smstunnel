# Changelog

## [1.1.0] - 2026-11-15

Needs SMSTunnel with scheduled texts on the server. A server from before them refuses **Send At** with a 400
(`property sendAt should not exist`), the node reports it like any 400, and nothing is sent.

### Added

- **Send At** (Message → Send, under Additional Fields): send the text later instead of now, 1 minute to 30 days
  ahead. SMSTunnel keeps it and sends it then with the same key; the output has `scheduled: true`, `scheduledId` and
  `sendAt`. A time from the date picker, which has no offset, is read in the workflow's time zone; a time with an
  offset, a Date or an expression's date is used as it is. It always goes out as a full ISO 8601 time in UTC, and a
  date that doesn't exist (30 February) stops the item before anything is sent. Not offered for Send 2FA Code or Send
  to Several Recipients, which still send right away (a Send At left on them stops the item).
- **Scheduled Text** resource: **Get Many** (Waiting or Done, with Page and Limit), **Get** and **Cancel**, for the
  texts this API key scheduled.

### Changed

- With Continue On Fail, a failed item keeps n8n's `error` and, when SMSTunnel answered, also gets SMSTunnel's
  `description`, `code` (such as `SCHEDULE_TOO_SOON`) and `httpCode`.
- `npm test` builds the node and runs its tests (`test/`, with Node's own test runner and no new dependencies).
