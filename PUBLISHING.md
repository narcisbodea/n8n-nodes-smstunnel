# Publishing n8n-nodes-smstunnel 1.2.0

How 1.2.0 gets from this folder to npm (with provenance) and into n8n's verified community nodes, so people on n8n
Cloud can install it. Everything below is still to do; nothing has been pushed or published.

Who does what:

- **[Owner]**: needs Narcis's own logins, 2FA or approval (GitHub, npmjs.com, the n8n Creator Portal).
- **[Agent, after OK]**: commands an agent can run once the owner says so (they need the owner's `gh` login on this
  computer).

Order matters: the npm Trusted Publisher (step 3) expires if the first publish (step 4) doesn't follow within 2 days.

## 0. Where things stand

- Source: `D:\ANDROID\n8n-nodes-smstunnel`, git branch `main`, one commit per change since the 1.1.0 baseline.
  The untracked `%TEMP%claude-task-start.txt` is a stray file and is not part of the repository.
- `npm test` (build and unit tests), `npm run lint` (`n8n-node lint`) and `npm run scan` (n8n's scanner,
  `@n8n/scan-community-package` 0.44.0, local checks) pass. `npm run test:e2e` has run against a local SMSTunnel API.
  To set up a copy: `npm ci --ignore-scripts` and `npm ci --ignore-scripts --prefix tools/scan` (the scanner is
  pinned apart, in tools/scan, with its own lockfile).
- Published on npm today: 1.1.0, without provenance; n8n's scanner refuses it for that reason alone.

## 1. The public GitHub repository

1. **[Owner]** On GitHub, as `narcisbodea`: **New repository** → name `n8n-nodes-smstunnel`, **Public**, no README,
   no .gitignore, no license (the repository has them). n8n checks that the repository is public and that npm's
   `repository` (`git+https://github.com/narcisbodea/n8n-nodes-smstunnel.git`) points to it.
2. **[Agent, after OK]** Push:

   ```bash
   cd D:/ANDROID/n8n-nodes-smstunnel
   git remote add origin https://github.com/narcisbodea/n8n-nodes-smstunnel.git
   git push -u origin main
   ```

   (Or both steps at once, with the owner's `gh` login: `gh repo create narcisbodea/n8n-nodes-smstunnel --public
   --source=. --remote=origin --push`.)
3. **[Owner]** In the repository's **About**: description *Send texts from your n8n workflows through your own
   Android phone and number*, website `https://smstunnel.io/integrations/n8n/`, topics `n8n`,
   `n8n-community-node-package`, `sms`, `android`.
4. The **CI** workflow runs on the push (lint, build, tests). It should be green before step 4.

## 2. The GitHub environment `npm` (approval before every publish)

**[Owner]** Repository → **Settings** → **Environments** → **New environment** → name `npm`:

- **Required reviewers**: add `narcisbodea`. Leave **Prevent self-review** off: the owner both makes the release
  and approves it.
- **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule** →
  **Ref type: Tag**, pattern `v*`.
- No secrets: publishing uses OIDC, not a token.

Every release then stops at the `publish` job until the owner clicks **Review deployments → Approve and deploy** in
the run (GitHub → Actions → Publish).

Optional: **Settings → Rules → Rulesets → New tag ruleset** for `v*`, so that only the owner can create release tags.

## 3. npm Trusted Publisher (one time)

**[Owner]** On https://www.npmjs.com (login and 2FA) → **n8n-nodes-smstunnel** → **Settings** → **Trusted
Publisher** → **GitHub Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `narcisbodea` |
| Repository | `n8n-nodes-smstunnel` |
| Workflow filename | `publish.yml` (the file name only) |
| Environment name | `npm` |
| Allowed actions | tick **npm publish** (configurations made after 3 September 2026 allow only `npm stage publish` unless this is ticked) |

npm doesn't check these when they're saved; a typo shows up only as a failed publish (`ENEEDAUTH`). All fields are
case-sensitive. The configuration must be used by a first successful publish **within 2 days**, or it expires and has
to be made again: do step 4 right after.

After 1.2.0 is out with provenance (step 4): **Settings → Publishing access → Require two-factor authentication and
disallow tokens**, and revoke any npm token that was used to publish from this computer.

## 4. Release 1.2.0 (publishes with provenance)

1. **[Agent, after OK]** Put the date on the changelog entry, commit and push:

   ```bash
   cd D:/ANDROID/n8n-nodes-smstunnel
   # CHANGELOG.md: "## [1.2.0] - unreleased" → "## [1.2.0] - <today's date, YYYY-MM-DD>"
   git add CHANGELOG.md
   git commit -m "Release 1.2.0"
   git push
   ```

2. **[Agent, after OK]** Make the GitHub release (the tag must be `v` + the version in package.json, on `main`):

   ```bash
   gh release create v1.2.0 --target main --title "1.2.0" --notes "See CHANGELOG.md: version 2 of the node (one recipient per call), ready for n8n's verified community nodes."
   ```

   Or **[Owner]**: GitHub → **Releases** → **Draft a new release** → tag `v1.2.0` on `main` → title `1.2.0` →
   **Publish release** (not a pre-release: pre-releases are not published).
3. The **Publish** workflow starts:
   - job **build** (read-only): checks that the tag is `v1.2.0` = package.json's version, still points at the release's
     commit and is on `main`; then `npm ci`, lint, build, tests, n8n's scanner, `npm pack`, and a check of the tarball
     (`scripts/check-package.mjs`: the declared node, credentials, icons and codex are in, nothing else is, the version
     is the tag's); it hands the `.tgz` on as an artifact;
   - job **publish** (environment `npm`): waits for approval.
4. **[Owner]** GitHub → **Actions** → the **Publish** run → **Review deployments** → `npm` → **Approve and deploy**.
   The job runs `npm publish ./package/n8n-nodes-smstunnel-1.2.0.tgz --provenance --access public --ignore-scripts`
   with npm 11.21.1, authenticated by OIDC. The `./` matters: without it npm reads `package/<file>.tgz` as a GitHub
   repository (user/repo) and fails with git error 128, as the first 1.2.0 run did.
5. **[Agent, after OK]** Check the result:

   ```bash
   cd D:/ANDROID/n8n-nodes-smstunnel
   npm view n8n-nodes-smstunnel@1.2.0 dist.attestations          # a provenance entry (predicateType https://slsa.dev/provenance/v1)
   # n8n's scanner, pinned with its integrity in tools/scan (no npx: nothing fetched unpinned at run time)
   npm ci --ignore-scripts --prefix tools/scan
   node tools/scan/node_modules/@n8n/scan-community-package/dist/cli.js n8n-nodes-smstunnel@1.2.0   # provenance, attested GitHub source, lint
   ```

   The npm page shows **Built and signed on GitHub Actions**. If the publish job fails with `ENEEDAUTH`, compare the
   Trusted Publisher fields (step 3) with the repository, `publish.yml` and `npm`, exactly.

   On Windows, run the scanner from PowerShell, which uses Windows' own `tar.exe`. Under Git Bash, GNU tar reads
   `C:\…` as a remote host, and the scanner stops at *Could not fetch source* although the package is fine.

## 5. Submit to n8n for verification (Creator Portal)

**[Owner]** Sign up or log in at https://creators.n8n.io/nodes and submit `n8n-nodes-smstunnel` **1.2.0** for
verification. The form is only visible after login and n8n doesn't document its fields; these are the values to give
for what it asks (and what n8n's list of verified nodes shows: package, display name, description, company, author):

| Field | Value |
| --- | --- |
| npm package | `n8n-nodes-smstunnel` |
| Version | `1.2.0` (the one with provenance) |
| Node display name | `SMSTunnel` |
| Short description | `Send texts (SMS) from your workflows through your own Android phone and number.` |
| Description | `SMSTunnel sends each text from your own Android phone, from its own SIM, so recipients see a number they know and can reply to. The node sends a text to one person (now or at a set time), sends sign-in codes, looks up a text's status, lists your phones, your usage and your scheduled texts, and reads received texts when you allow it. It can be an AI Agent's tool for sending one text at a time.` |
| Category | `Communication` (as in the codex file) |
| Documentation | `https://smstunnel.io/integrations/n8n/` (live; checked on 17 November 2026) |
| Repository | `https://github.com/narcisbodea/n8n-nodes-smstunnel` |
| npm page | `https://www.npmjs.com/package/n8n-nodes-smstunnel` |
| Company | `NARBOWEB SRL` |
| Website | `https://smstunnel.io` |
| Author | `Narcis Bodea` (GitHub `narcisbodea`) |
| Support / contact email | `contact@narboweb.ro` |
| Credentials | API key (sent as `X-API-Key`) and Base URL (`https://smstunnel.io`); the credentials' Test calls `GET /api/v1/account/usage` |
| Icon | `nodes/SmsTunnel/smstunnel.svg` (64×64 SVG, used for both themes) |
| Example use | an Error Trigger that texts you when a workflow fails; appointment reminders with **Send At**; a list of numbers through **Split Out** into **Send** (all in the README) |

- If the form asks for a way to try the node: a reviewer needs an SMSTunnel account with a linked Android phone.
  Offer a separate test account and key on smstunnel.io with low limits, and delete the key after the review. Never put
  a key in a public field.
- **Confirmation email.** The portal sends a token to the package's author email as npm reports it. The package says
  `contact@narboweb.ro`; the npm account that maintains it uses another address (the owner's own). Other authors got *Error
  getting author email from npm* when the two differed. If that happens, either make the npm account's email
  `contact@narboweb.ro`, or change `author.email` in package.json to the npm account's email and release 1.2.1 (steps
  4–5 again). Check also the spam folder of both addresses.
- **Review time**: up to four weeks (n8n's documentation); n8n emails as the submission moves on. An automated review
  (n8n's scanner) runs first. If the portal says *tests failed* while the scanner of step 4.5 passes, n8n's portal may
  be on another scanner version (n8n's advice on its forum, July 2026, was to try the `beta` one): see which version
  that is (`npm view @n8n/scan-community-package dist-tags`), pin it in tools/scan
  (`npm install --ignore-scripts --save-exact --prefix tools/scan @n8n/scan-community-package@<version>`) and run it
  the same way, rather than through npx. A review stuck in progress: email nodes@n8n.io or ask on n8n's Discord
  (#community-nodes).
  n8n may refuse nodes that compete with its paid features; this one doesn't.

After verification, owners and admins of an n8n instance (Cloud included) find **SMSTunnel** under **More from the
community** in the nodes panel and install it with one click. n8n pins each verified version by checksum: a later
version reaches Cloud only after it is released the same way (steps 4–5) and submitted again.

## Later releases

1. Set `version` in package.json (`npm version 1.2.1 --no-git-tag-version`) and add the changelog entry; merge to
   `main`.
2. Release `v<version>` from `main` (step 4), approve the `npm` deployment, check provenance.
3. Submit the new version in the Creator Portal.

`npm publish` from a computer is refused on purpose (`prepublishOnly` runs `n8n-node prerelease`): a package without
provenance can't be verified.
