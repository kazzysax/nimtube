# Deploying NimTube to Nimiq Pay

Read this in order. Step 4 is where things will actually break.

---

## 0. What you need

| | |
|---|---|
| Anthropic API key | market creation and resolution both go through it |
| A host with **HTTPS** | Nimiq Pay will not load an `http://` mini app |
| A phone with Nimiq Pay installed | the only way to test the real integration |
| Persistent disk, or Postgres | SQLite on an ephemeral filesystem loses every account on redeploy |
| Node 22.5+ | uses the built-in `node:sqlite` — no compiler needed on the host |

---

## 1. Prove it works locally first

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY
npm start
```

Open `http://localhost:3000` in a desktop browser. It falls back to a dev wallet in
localStorage, so the whole app is usable without Nimiq Pay.

**Post a market before doing anything else.** The gate is the riskiest component and
until you've watched it accept a good question and reject a vague one, nothing else
matters. Try `will bitcoin pump this month` — it should reject and offer a fix.

Then force a resolution rather than waiting for the clock:

```bash
curl -XPOST localhost:3000/api/admin/tick -H "x-admin-key: $ADMIN_KEY"
```

---

## 2. Deploy

Any Node host works. The app is a single process serving both API and client.

**Railway / Render / Fly** — connect the repo, set the env vars below, and **attach a
persistent volume mounted where `DB_FILE` points**. Without a volume, SQLite lives on
ephemeral disk and every user disappears on the next deploy.

```
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-5
DB_FILE=/data/nimtube.db          # must be on the mounted volume
PORT=3000
ADMIN_KEY=<long random string>
NIMIQ_RPC_URL=https://your-node/rpc   # without this, tips are never confirmed
TIP_MIN_CONFIRMATIONS=10
# ALLOW_DEV_LOGIN=1   # local only. Never set this in production — it skips
                      # signature verification so you can work outside Nimiq Pay.
RESOLVER_TICK_MS=60000
```

Verify: `curl https://your-app.com/api/health` → `{"ok":true}`

**If you move to Postgres**, only `src/core/db.js` changes shape — nothing else
talks to the database driver directly.

---

## 3. Required before real users

These are not optional once money is involved.

**HTTPS with a real certificate.** Self-signed will be refused.

**Serve `public/` over the same origin.** `requestDeviceIdentifier()` is scoped to
your mini app's origin — split the client onto a different domain and the identifier
changes, breaking your anti-alt signal.

**Rate limit `/api/markets`.** Every call costs an Anthropic request. The in-app
limit is 5 markets per user per day, but that's per account, and accounts are free.

**Back up the database.** Reputation is the entire product and it exists in one file.

**Point `NIMIQ_RPC_URL` at your own node.** The public open servers are fine while
building, but the docs are explicit that they carry no uptime guarantee and are not
for production — and this is the code deciding whether someone's money arrived. If
the RPC is unset the app still runs; tips simply stay unconfirmed forever.

---

## 4. Open it inside Nimiq Pay

```
nimiqpay://miniapp?url=your-app.com
```

Note the URL has **no scheme** — `your-app.com`, not `https://your-app.com`.

Send yourself that link and tap it on a phone with Nimiq Pay installed. Because your
URL isn't in Nimiq Pay's mini app list yet, you'll get a warning screen first. That's
expected.

### What should happen

1. App loads in the WebView
2. Welcome screen, tap **Get started**
3. Native dialog asks you to approve account access
4. A second dialog asks for the device identifier, quoting your reason string
5. Username step, then niches, then follow, then the feed

### What will probably go wrong

**The SDK doesn't load.** `public/nimiq.js` pulls `@nimiq/mini-app-sdk` from
`esm.sh` at runtime. If the WebView blocks that or the package name has moved, you'll
see *"provider found but the SDK failed to load"*. Fix: `npm i @nimiq/mini-app-sdk`,
bundle it, and import locally instead of from a CDN.

**Sign-in needs two dialogs, not one.** Account access, then message signing to prove
you hold the key. If the second is missing you'll get *"Signature required"* — that is
the server refusing to trust an unproven address, and it is correct behaviour.

**Tipping.** Now built against the documented call —
`sendBasicTransactionWithData({ recipient, value, data })`, returning the hash as a
plain string. Values are in luna (1 NIM = 100,000). If it fails, the two errors worth
recognising are `PermissionDeniedError` (user cancelled) and `InvalidTransactionError`
(malformed), both already handled.

**Nothing renders at all.** The client is a native ES module. If the WebView is old
enough to choke on `import`, you'll need a build step — Vite with a legacy target.

Debug by connecting the phone over USB and opening `chrome://inspect`.

---

## 5. Still unfinished

Do not ship to real users with these open:

- **Bounties draw but never pay.** Winners land in `bounty_awards` with `paid=0`.
  Needs a payout job and a funded app wallet — and the funds should lock at post
  creation, not at settlement, or the creator's wallet can be empty when it resolves.
- **No comments.** The spec unlocks them after wagering.
- **Alt accounts.** `device_hash` is collected and unused. It's the obvious first
  signal: several accounts sharing a device hash is the cheapest attack on
  reputation, and the cheapest to detect.

---

## 6. For the hackathon

Scoring weights design, functionality, usefulness, and marketing roughly equally, so
the last quarter is about getting real people to use it — not more features.

The shareable resolution card is your distribution engine: *called it at 20% against
the crowd, and was right*, with a timestamp proving it. Make sure `/?m=<id>` renders
a proper OpenGraph image of that card, or every share lands as a bare link.

Submissions need a public GitHub repo, so keep `.env` out of it. `.gitignore` already
covers it.
