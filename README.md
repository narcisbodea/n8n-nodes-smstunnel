# n8n-nodes-smstunnel

An [n8n](https://n8n.io) community node for **[SMSTunnel](https://smstunnel.io)** — send texts from your workflows through **your own Android phone**, from **your own number**.

Your workflow hands the text to your SMSTunnel account and your phone sends it from its own SIM, so recipients see a number they know and can reply to. The phone is linked to your account when you sign in to the SMSTunnel app (or scan the QR code from your dashboard), and you can cut a workflow off anytime by deleting its API key in your dashboard.

Your phone needs the SMSTunnel app from Google Play:

<a href="https://play.google.com/store/apps/details?id=io.smstunnel.app"><img src="https://smstunnel.io/google-play-badge.png" alt="Get it on Google Play" height="56"></a>

## Installation

The node needs n8n 1.85 or later.

### n8n Cloud and self-hosted, from the nodes panel

Once n8n has verified this node:

1. Open a workflow and the nodes panel (**+**, or press **N**).
2. Search for **SMSTunnel**. It shows up under **More from the community**.
3. Select it and select **Install**. Only the instance owner and admins can install; everyone on the instance can use it afterwards.

On self-hosted n8n, verified community nodes show up there unless they have been turned off ([installing verified community nodes](https://docs.n8n.io/integrations/community-nodes/installation-and-management/install-verified-community-nodes/)).

### Self-hosted, from Settings

1. In n8n, go to **Settings → Community Nodes**.
2. Select **Install**.
3. Enter `n8n-nodes-smstunnel`.
4. Agree to the risks of using community nodes and select **Install**.

### Manual installation

```bash
# in your n8n installation directory
npm install n8n-nodes-smstunnel
```

For Docker-based deployments, add the package to your custom image or mount it into `~/.n8n/custom`.

## Credentials

You need an SMSTunnel API key:

1. Install the [SMSTunnel app from Google Play](https://play.google.com/store/apps/details?id=io.smstunnel.app) on your Android phone and sign in. Sign in at [smstunnel.io](https://smstunnel.io) on your computer with the same account: the phone appears under **Phones** (you can also link it with the QR code from **Phones → Add phone**).
2. In your [SMSTunnel dashboard](https://dashboard.smstunnel.io/apps), open **Apps** → **Add an app**, choose **n8n** and copy its key. The key can send texts and look up whether they went out.
3. **Get Received** only works with a key you have explicitly allowed to read received texts (**Can also read received texts** when you create it, or **Allow reading received texts** later). Syncing received SMS is off by default in the app; when you turn it on, only texts that arrive from then on are synced, and the phone's existing messages are never read.

In n8n, create new **SMSTunnel API** credentials:

| Field | Description |
| --- | --- |
| **API Key** | The key you generated. Sent as the `X-API-Key` header. |
| **Base URL** | `https://smstunnel.io`. Your API key is sent to this address: keep it unless you run your own SMSTunnel server, whose address must start with `https://`. |

Use **Test** to verify the credentials before saving. The key only ever goes to the Base URL: the node refuses an address with `http://` (other than `localhost`), a user name or password, a query or a fragment, and these credentials don't send the key anywhere else, not even from an HTTP Request node.

## Operations

New SMSTunnel nodes are version 2: each run of an item sends at most one text, to one person.

### Message

| Operation | Description |
| --- | --- |
| **Send** | Send an SMS to one recipient, now or at a later time (**Send At**, see [Scheduled texts](#scheduled-texts)). |
| **Send 2FA Code** | Send a sign-in code (2FA). Uses the separate 2FA quota. |
| **Get Status** | Look up the delivery status of a message by its ID. |
| **Get Received** | Get received SMS synced from your phone. Needs sync turned on in the app and a key you allowed to read received messages (`sms:inbox`). |

### Account

| Operation | Description |
| --- | --- |
| **Get Usage** | Current quota and consumption. |

### Device

| Operation | Description |
| --- | --- |
| **Get Many** | List the devices paired with the account. |

### Scheduled Text

| Operation | Description |
| --- | --- |
| **Get Many** | The texts this API key scheduled: **Waiting** (not gone out yet, soonest first) or **Done** (sent, failed or canceled in the last 30 days, newest first), with **Page** and **Limit** (up to 100 a page). |
| **Get** | One scheduled text by its ID. Once it went out, `messageId` is set: follow it with **Get Status**. |
| **Cancel** | Cancel a scheduled text before it goes out. |

### Additional fields

- **Default Country Code** — e.g. `+40`. Prepended to numbers that don't already start with `+` or `00`, so you can pass local numbers.
- **Device ID** — send through one specific phone. Leave empty to let the server pick.
- **Send At** (**Send** only) — send the text later instead of now. See [Scheduled texts](#scheduled-texts).

## Texting a list of numbers

n8n runs the node once for every item it gets, so one item per number means one text per number:

1. Get the numbers as a list, for example a field `phones` with `["+14155550101", "+14155550102"]`. (From a comma-separated text: `{{ $json.numbers.split(',').map(n => n.trim()) }}` in an **Edit Fields** node.)
2. Add a **Split Out** node: **Fields To Split Out** `phones`, and under **Options**, **Destination Field Name** `phone`.
3. Add **SMSTunnel**, **Message → Send**, with **To** `{{ $json.phone }}`.

SMSTunnel takes 30 sends a minute per API key. When a run of the node reaches that, the node waits for the time SMSTunnel gives (`Retry-After`) and goes on, waiting at most 60 seconds in all in one run; past that, the items left fail with the `429` and its `Retry-After`. For more than about 60 numbers at once, add **Loop Over Items** (batches of 25) with a **Wait** of one minute after the SMSTunnel node.

## Scheduled texts

Set **Send At** on a **Send** and SMSTunnel keeps the text and hands it to your phone at that time, 1 minute to 30 days ahead, exactly as if the workflow had sent it then (the same key, phone and country code, and that day's allowance). If the phone is offline then, the text waits for it, up to 3 days.

Example: a reminder the morning before an appointment. **Send**, **To** `{{ $json.phone }}`, **Message** `Reminder: your appointment is tomorrow at {{ $json.time }}.`, and **Send At** `{{ DateTime.fromISO($json.date).minus({ days: 1 }).set({ hour: 9, minute: 0 }) }}`. The output then has `scheduled: true`, `scheduledId` and `sendAt` (in UTC) instead of a `messageId`.

- A time picked in the date picker has no offset: the node reads it in the workflow's time zone (**Workflow settings → Timezone**, or the instance's default). A time with an offset (`2026-11-16T09:00:00+02:00`, or an expression's date) is used as it is. The node always sends it as a full ISO 8601 time in UTC; a date that doesn't exist stops the item before anything is sent.
- **Scheduled Text → Cancel** with the `scheduledId` cancels it while it waits; **Get Many** lists what is waiting. A key sees and cancels only the texts it scheduled; your dashboard shows them all under **Messages → Scheduled**.
- Texts waiting at once, per plan: Free 10, Starter 50, Standard 200, Professional 500, Enterprise 1000. Sign-in codes always go out right away.

## Notes and limits

- **Rate limit**: 30 sends a minute per API key. Version 2 waits for SMSTunnel's `Retry-After` (at most 60 seconds in all per run); see [Texting a list of numbers](#texting-a-list-of-numbers). Your plan's daily limit is not waited for: the item fails with SMSTunnel's words.
- **No double texts**: every text goes out with its own `Idempotency-Key`, the same on every try of it, and the node only tries a text again after SMSTunnel's per-minute limit, which refuses a request before it is handled. A text is never sent again after a timeout or a server error.
- **Phone offline**: the text waits on SMSTunnel and goes out when the phone is back.
- **Message length**: up to 1600 characters (10 concatenated SMS). 2FA messages are limited to 320 characters.
- **2FA validation**: the server checks that the message actually contains a sign-in code of 4 to 10 digits (or `123-456`) and rejects it otherwise. Include the code in the text, e.g. `Your code is 482913`.
- **IDs**: **Message ID** and **Scheduled Text ID** must be the IDs SMSTunnel returned (24 characters, digits and the letters a to f); anything else stops the item before a request is made.
- **Errors**: enable *Continue On Fail* on the node if you want failed items to produce an `error` field instead of stopping the workflow. When SMSTunnel answered, the item also has its words in `description`, its `code` (such as `SCHEDULE_TOO_SOON` or `SCHEDULE_LIMIT_REACHED`) and the HTTP status in `httpCode`. Only a `2xx` answer counts; the node follows no redirects.

## Workflows saved with version 1

Workflows made before 1.2.0 keep their SMSTunnel nodes at version 1, with the same operations, parameters, credentials and outputs, so they go on working as they are.

- **Send to Several Recipients** (version 1 only) still takes up to 100 numbers in **To**, separated by commas, semicolons or new lines. It now sends one text per number, each its own request, and gives the same output as before: `data.messageIds`, `branded`, `count` and `remaining`, plus `refused` and `error` when some texts didn't go out (a number SMSTunnel refuses is listed and the others still go; the daily limit stops the list). If the phone is offline, the texts wait for it instead of the node stopping. It waits for the per-minute limit like version 2.
- To move to version 2, add a new SMSTunnel node (new nodes are version 2) and put a **Split Out** before it, as in [Texting a list of numbers](#texting-a-list-of-numbers).

## Example: alert when a workflow fails

1. Add an **Error Trigger** node.
2. Add this **SMSTunnel** node, resource **Message**, operation **Send**.
3. Set **To** to your number and **Message** to something like:

   ```
   Workflow {{$json["workflow"]["name"]}} failed: {{$json["execution"]["error"]["message"]}}
   ```

Because the message leaves from your own phone, this keeps working even when the destination has no internet connection.

## Using it as an AI tool

The node can be a tool of n8n's **AI Agent** (connect it to the agent's **Tool** input). As a tool it does only what can't pass on private texts or reach many people at once:

| As an AI tool | Operations |
| --- | --- |
| **Allowed** | **Send** (one text, now or with **Send At**), **Get Status**, **Account → Get Usage**, **Device → Get Many**, **Scheduled Text → Get** and **Get Many** |
| **Refused** | **Get Received** (received texts often hold sign-in codes), **Send 2FA Code**, **Scheduled Text → Cancel**, and **Send to Several Recipients** of version 1 |

The refused operations aren't listed in the tool, and the node stops with a message if one is set anyway. To use them, add SMSTunnel as a normal step of the workflow.

- **Set the recipient yourself.** Put your own number, or an expression from your own data, in **To**, and let the model fill only **Message**, for example `{{ $fromAI('message', 'The text to send', 'string') }}`.
- **One call is one text.** To confirm each text before it goes out, add a **Human review** step between the agent and this tool ([human-in-the-loop for AI tool calls](https://docs.n8n.io/build/integrate-ai/ai-examples/human-in-the-loop-for-tools/)).

## Build it with an AI assistant

Paste this into Claude, ChatGPT, Cursor or Copilot and replace the part in brackets. Don't paste your API key into the chat: the prompt doesn't need it.

```text
Help me build an n8n workflow that sends text messages from my own phone with SMSTunnel.

About SMSTunnel (https://smstunnel.io): my own apps and tools hand text messages (SMS) to my
SMSTunnel account, and my own Android phone sends them from my own number, on my own SIM and plan.
The phone runs the SMSTunnel app from Google Play
(https://play.google.com/store/apps/details?id=io.smstunnel.app), signed in to my account.

What I want: [describe what should send a text, to whom, and when]

How it works:
- Install the community node n8n-nodes-smstunnel: on n8n Cloud, search "SMSTunnel" in the nodes
  panel (More from the community) and install it; self-hosted, Settings → Community Nodes →
  Install → n8n-nodes-smstunnel (or npm install n8n-nodes-smstunnel). It needs n8n 1.85 or later.
- Credentials "SMSTunnel API": "API Key" (sent as the X-API-Key header) and "Base URL"
  (https://smstunnel.io; the key is only ever sent there). The Test button checks the key.
- Node "SMSTunnel" (version 2), resource Message: "Send" (To, Message) sends one text to one
  number (POST /api/v1/sms/send with { to, message }); "Send 2FA Code" (the message must contain
  a code of 4 to 10 digits standing on its own, or 123-456; up to 320 characters; separate
  allowance); "Get Status" (Message ID); "Get Received" (texts synced from the phone; the key must
  be allowed to read received texts). Resource Account: "Get Usage". Resource Device: "Get Many".
  Resource "Scheduled Text": "Get Many" (scope Waiting or Done), "Get" and "Cancel" (by ID).
- One recipient per text: n8n runs the node once per item, so for a list of numbers put each
  number in its own item first (Split Out), then Send with To = {{ $json.phone }}.
- Additional Fields: "Default Country Code" (e.g. +44; completes numbers written without + or 00
  and takes precedence over the phone's own setting) and "Device ID". "Send" also has "Send At":
  the text goes out at that time (1 minute to 30 days ahead; a time without an offset is read in
  the workflow's time zone) and the output has "scheduledId".
- Limits: messages up to 1600 characters; 30 sends a minute per API key. When that is reached the
  node waits for SMSTunnel's Retry-After, at most 60 seconds in all per run; for longer lists use
  Loop Over Items (batches of 25) with a 1-minute Wait. The plan's daily limit is not waited for.
- Errors: a failed item stops the workflow unless "Continue On Fail" is on; then the item gets
  "error", plus SMSTunnel's "description", "code" and "httpCode". 401 = wrong or deleted key,
  403 = the key lacks a permission or the plan doesn't allow it (see "code"), 429 = too many
  requests or the plan's daily limit, 5xx = SMSTunnel's side. A text is never sent twice: each
  goes out with its own Idempotency-Key. If the phone is offline, the text waits on SMSTunnel and
  goes out when it is back.
- The API key comes from my SMSTunnel dashboard (https://dashboard.smstunnel.io): Apps → Add an app
  → Create the key. It is shown only once and can send texts and check whether they went out.

Rules for your answer:
- Do not ask for my SMSTunnel password or API key and do not put a real key in your answer; I will
  not paste it in this chat. The key belongs in n8n's credentials (its secret store), never in a
  Code node, an expression, the workflow JSON or anything a browser loads.
- Phone numbers must be in international format (+ and the country code); validate them in the
  workflow before sending.
- Handle failed items (Continue On Fail, or an Error Trigger workflow).
- Help me test it with my own number first.
- Only send texts people expect from me. No unsolicited texts.
```

## Responsible use

Send only texts that people expect from you — alerts to yourself, appointment reminders, sign-in codes, order updates. Unsolicited messages from a personal SIM break most carriers' terms of service. Please make sure your usage complies with your carrier's terms and with local regulations (in the EU, that includes GDPR and ePrivacy rules on electronic communications).

## Resources

- [SMSTunnel](https://smstunnel.io) and its [n8n page](https://smstunnel.io/integrations/n8n/)
- [Source code and issues](https://github.com/narcisbodea/n8n-nodes-smstunnel)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Changelog](https://github.com/narcisbodea/n8n-nodes-smstunnel/blob/main/CHANGELOG.md)

This community node is made by NARBOWEB SRL, the makers of SMSTunnel. It is not affiliated with, endorsed by, or sponsored by n8n.

## License

[MIT](LICENSE)
