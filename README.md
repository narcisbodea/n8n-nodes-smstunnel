# n8n-nodes-smstunnel

An [n8n](https://n8n.io) community node for **[SMSTunnel](https://smstunnel.io)** — send texts from your workflows through **your own Android phone**, from **your own number**.

Your workflow hands the text to your SMSTunnel account and your phone sends it from its own SIM, so recipients see a number they know and can reply to. The phone is linked to your account when you sign in to the SMSTunnel app (or scan the QR code from your dashboard), and you can cut a workflow off anytime by deleting its API key in your dashboard.

Your phone needs the SMSTunnel app from Google Play:

<a href="https://play.google.com/store/apps/details?id=io.smstunnel.app"><img src="https://smstunnel.io/google-play-badge.png" alt="Get it on Google Play" height="56"></a>

## Installation

### Community Nodes (recommended)

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
| **Base URL** | `https://smstunnel.io` by default. Change it only for a self-hosted instance. |

Use **Test** to verify the credentials before saving.

## Operations

### Message

| Operation | Description |
| --- | --- |
| **Send** | Send an SMS to one recipient, now or at a later time (**Send At**, see [Scheduled texts](#scheduled-texts)). |
| **Send to Several Recipients** | Send the same text to several recipients (max 100 per request, rate-limited). |
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

## Scheduled texts

Set **Send At** on a **Send** and SMSTunnel keeps the text and hands it to your phone at that time, 1 minute to 30 days ahead, exactly as if the workflow had sent it then (the same key, phone and country code, and that day's allowance). If the phone is offline then, the text waits for it, up to 3 days.

Example: a reminder the morning before an appointment. **Send**, **To** `{{ $json.phone }}`, **Message** `Reminder: your appointment is tomorrow at {{ $json.time }}.`, and **Send At** `{{ DateTime.fromISO($json.date).minus({ days: 1 }).set({ hour: 9, minute: 0 }) }}`. The output then has `scheduled: true`, `scheduledId` and `sendAt` (in UTC) instead of a `messageId`.

- A time picked in the date picker has no offset: the node reads it in the workflow's time zone (**Workflow settings → Timezone**, or the instance's default). A time with an offset (`2026-11-16T09:00:00+02:00`, or an expression's date) is used as it is. The node always sends it as a full ISO 8601 time in UTC; a date that doesn't exist stops the item before anything is sent.
- **Scheduled Text → Cancel** with the `scheduledId` cancels it while it waits; **Get Many** lists what is waiting. A key sees and cancels only the texts it scheduled; your dashboard shows them all under **Messages → Scheduled**.
- Texts waiting at once, per plan: Free 10, Starter 50, Standard 200, Professional 500, Enterprise 1000. Sign-in codes and **Send to Several Recipients** always go out right away.

## Notes and limits

- **Rate limit**: the send endpoints allow 30 send requests per minute. To text a few people at once, put them in one **Send to Several Recipients** request instead of looping **Send**.
- **Recipients per request**: at most 100. The node stops with a clear error message if you pass more.
- **Message length**: up to 1600 characters (10 concatenated SMS). 2FA messages are limited to 320 characters.
- **2FA validation**: the server checks that the message actually contains a sign-in code and rejects it otherwise. Include the code in the text, e.g. `Your code is 12-345678`.
- **Errors**: enable *Continue On Fail* on the node if you want failed items to produce an `error` field instead of stopping the workflow. When SMSTunnel answered, the item also has its words in `description`, its `code` (such as `SCHEDULE_TOO_SOON` or `SCHEDULE_LIMIT_REACHED`) and the HTTP status in `httpCode`.

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
- Install the community node: in n8n, Settings → Community Nodes → Install → n8n-nodes-smstunnel
  (self-hosted: npm install n8n-nodes-smstunnel).
- Credentials "SMSTunnel API": "API Key" (sent as X-API-Key) and "Base URL" (https://smstunnel.io).
  The Test button checks the key.
- Node "SMSTunnel", resource Message: "Send" (To, Message); "Send to Several Recipients" (To: up to
  100 numbers separated by commas, semicolons or new lines; each gets its own text; needs the phone
  to be online); "Send 2FA Code" (the message must contain a code of 4 to 10 digits, up to 320
  characters; separate allowance); "Get Status" (Message ID); "Get Received" (texts synced from the
  phone; the key must be allowed to read received texts). Resource Account: "Get Usage". Resource
  Device: "Get Many".
- Additional Fields on the send operations: "Default Country Code" (e.g. +44; completes numbers
  written without + or 00 and takes precedence over the phone's own setting) and "Device ID".
  "Send" also has "Send At": the text goes out at that time (1 minute to 30 days ahead; a time
  without an offset is read in the workflow's time zone) and the output has "scheduledId".
  Resource "Scheduled Text": "Get Many" (scope Waiting or Done), "Get" and "Cancel" (by ID).
- Messages up to 1600 characters. SMSTunnel allows 30 send requests a minute: to text a few people
  at once, use one "Send to Several Recipients" request instead of a loop of "Send".
- A failed call stops the workflow unless "Continue On Fail" is on; then the item gets an "error"
  field. The node does not retry after 429 (too many requests). If the phone is offline, a "Send"
  text waits and goes out when it is back.
- The API key comes from my SMSTunnel dashboard (https://dashboard.smstunnel.io): Apps → Add an app
  → Create the key. It is shown only once and can send texts and check whether they went out.

Rules for your answer:
- Do not ask for my SMSTunnel password or API key and do not put a real key in your answer; I will
  not paste it in this chat.
- Phone numbers must be in international format (+ and the country code).
- Help me test it with my own number first.
- Only send texts people expect from me. No unsolicited texts.
- Validate phone numbers in the workflow before sending, and handle failed items.
```

## Responsible use

Send only texts that people expect from you — alerts to yourself, appointment reminders, sign-in codes, order updates. Unsolicited messages from a personal SIM break most carriers' terms of service. Please make sure your usage complies with your carrier's terms and with local regulations (in the EU, that includes GDPR and ePrivacy rules on electronic communications).

## Resources

- [SMSTunnel](https://smstunnel.io)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE)
