# Changelog

## [1.2.0] - 2026-11-18

Ready for n8n's verified community nodes (installable on n8n Cloud once n8n has verified it). Needs n8n 1.85 or
later (March 2025): an older n8n can't load this version; stay on 1.1.0 there.

### For existing users

- **Credentials** stay as they are: the same credential type (`smsTunnelApi`) and fields, so saved credentials keep
  working. The Base URL must now start with `https://` (`http://` only for `localhost` and `127.0.0.1`) and may not
  carry a user name, password, query or fragment; with any other Base URL the node stops before it sends anything
  (`https://smstunnel.io`, the default, is fine).
- **Saved workflows** keep their SMSTunnel nodes at version 1, with the same operations and parameters. In version 1:
  - **Send to Several Recipients** no longer calls the API's several-recipients endpoint. It sends one
    `POST /api/v1/sms/send` per number and gives the **same output**: `success` and
    `data: { messageIds, branded, count, remaining }`, plus `refused` and `error` when some texts didn't go out.
    What differs: a number SMSTunnel refuses is listed in `refused` (as written in **To**) and the other numbers still
    get their text, where the single request refused the whole list; an answer without a `messageId` counts as not
    sent; an offline phone makes the texts wait instead of failing the item; it waits for SMSTunnel's per-minute
    limit (below) instead of failing. 100 numbers per item at most, as before. As an AI tool it is refused.
  - **Send**, **Send 2FA Code** and the other operations answer as in 1.1.0. Every text now carries an
    `Idempotency-Key`, and no request follows a redirect.
- **Message ID** and **Scheduled Text ID** must be SMSTunnel's own ids (24 characters, digits and the letters a to
  f); anything else stops the item before a request is made (it used to reach SMSTunnel and come back as a 404).
- The canvas shows the operation's name (**Send to Several Recipients: Message**) instead of its stored value.

### Added

- **Node version 2**, the version of new nodes: one text per item, to one person; no Send to Several Recipients
  (put each number in its own item with **Split Out**, see the README). It waits for SMSTunnel's per-minute limit:
  on a `429` with `Retry-After` it waits and sends the same request again, at most 3 times per request and at most
  60 seconds in all in one run, shared by every item; past that the item fails with the `429` and its `Retry-After`.
  The plan's daily limit (a `429` without `Retry-After`) is not waited for.
- **AI tool**: the node can be a tool of n8n's AI Agent (`usableAsTool`, new in this version; 1.1.0 didn't have it).
  As a tool it only sends one text (**Send**, with or without **Send At**) or reads what isn't private (**Get
  Status**, **Get Usage**, the phones, **Scheduled Text → Get** and **Get Many**). **Get Received**, **Send 2FA
  Code**, **Scheduled Text → Cancel** and version 1's **Send to Several Recipients** are refused as a tool, and
  hidden from the tool's operation list.
- An `Idempotency-Key` on every request that sends a text (Send, with or without Send At, Send 2FA Code, each number
  of Send to Several Recipients), one per text and the same on every try of it: SMSTunnel answers a repeated key with
  the first answer instead of sending again.
- Icons for the credentials, light and dark; a codex file (category **Communication**, docs link
  https://smstunnel.io/integrations/n8n/).

### Security

- The API key goes only to the credentials' Base URL, checked as above. The credentials add the key in their own
  `authenticate()` and only for a request to that Base URL, so the **Test** button and an HTTP Request node that uses
  these credentials get the same check; redirects are not followed (the key would go along).
- Only SMSTunnel's own id format goes into a URL path (`..` could make a dot segment before).
- Only a `2xx` answer counts: a `3xx` or another unexpected status is an error.
- A text is asked for again only after a `429` with `Retry-After`, which SMSTunnel answers before handling the
  request; never after a timeout, a network error or a `5xx`.

### Changed

- Built and linted with n8n's own tooling (`@n8n/node-cli`: `n8n-node build`, `n8n-node lint`); passes
  `@n8n/scan-community-package`. Published from GitHub Actions with npm provenance (n8n requires it for verified
  nodes since 1 May 2026); `npm publish` from a computer is refused.
- `repository` and `bugs` point to https://github.com/narcisbodea/n8n-nodes-smstunnel.

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
