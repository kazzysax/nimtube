# PredTube

A social prediction app that runs as a Nimiq Pay mini app. Posts are the markets.
You stake points to take a side, and reputation is handed out by how surprising the
outcome was.

Points have no cash value and can't be bought. NIM only ever appears in tips and
bounties — never in a wager.

## Run it

**Needs Node 22.5+** (uses the built-in `node:sqlite`, so there is no native build step).

```bash
npm install
cp .env.example .env      # add your ANTHROPIC_API_KEY
npm start                 # http://localhost:3000
npm test                  # economy maths
node test/e2e.test.mjs    # full API walkthrough
```

Without an API key the server still runs — you just can't create or resolve
markets, since both go through the terminal.

Open it in a desktop browser and it falls back to a dev wallet stored in
localStorage, so you can build the whole app without Nimiq Pay in the loop.

## Testing inside Nimiq Pay

Deploy anywhere with HTTPS, then open on a phone with Nimiq Pay installed:

```
nimiqpay://miniapp?url=your-app.com
```

Nimiq Pay warns before loading a URL that isn't in its mini app list. Everything
sensitive — listing the account, sending NIM — goes through a native confirmation
dialog you can't bypass or style.

## Layout

```
src/core/math.js      the entire economy: weight, the 25% cap, the bar, rep bands
src/core/terminal.js  the AI gate (creation) and resolver (settlement)
src/core/markets.js   market lifecycle, wagering, settlement
src/core/users.js     identity, username folding, profiles
src/jobs/resolver.js  the clock: closes markets, settles them, retries, voids
src/server.js         HTTP API
public/nimiq.js       Mini App SDK adapter with a browser fallback
public/app.js         the client
```

## The parts that matter

**The economy lives in one file.** `math.js` has no database access and no side
effects, so the rules can be tested directly and can't drift between callers.

**Weight.** `stake × repFactor × timeFactor`. Rep factor is `1 + rep/100`, capped at
2× and floored at 1× — a negative-rep user must never be muted. Time factor slides
1.2× at open to 1.0× at close.

**The 25% cap is self-referential** — trimming a wager changes the total, which
changes the ceiling. `applyCap` iterates to a fixed point, converging on the largest
wager equalling a third of everyone else combined. It's dormant below five wagers,
where the constraint is mathematically unsatisfiable and would otherwise collapse
every weight to zero.

**One wager per market** is a `UNIQUE (market_id, user_id)` constraint. Not
application logic — the database refuses it.

**Two AI calls, never one.** The gate reasons hard and rewrites. The resolver does
not reason; it looks up the frozen rule with web search and returns `YES`, `NO`, or
`VOID`. Anything else is treated as `VOID` and flagged for a human. That separation
is what stops a market being settled on a different standard than the one people
wagered against.

**Resolution is a scheduled job**, never triggered by a request, so rep and refunds
land at the same instant for everyone. A flaky source is retried four times over
hours before it's called void.

**Void is an undo, not an outcome.** Every stake refunded, no rep moved, bounty
returned. One-sided markets void automatically — a bet with nobody on the other side
isn't a bet.

**Usernames fold before uniqueness.** Case, separators, accents, `rn`→`m`, `0`→`o`,
`1`/`l`→`i`, Cyrillic lookalikes. Tips are real money, so a name that *reads* like a
high-rep predictor is an impersonation vector.

**Bounties draw at random** among whoever was correct, never weighted by stake.
That keeps them EV-neutral across sides, so money never pulls people toward the safe
call.

## Verified against the docs

Built against the published Nimiq provider API:
`listAccounts()` → `string[]`, `sign(message)` → `{ publicKey, signature }`,
`sendBasicTransactionWithData({ recipient, value, data })` → transaction hash string,
`requestDeviceIdentifier({ reason })` → 64-char hex.

**Sign-in proves ownership.** The server issues a one-time nonce, the client signs it
through Nimiq Pay, and the server checks both the signature and that the public key
derives to the claimed address. Without that step the session endpoint would hand out
an account to anyone who typed someone else's address.

**The device identifier is never an identity.** The docs are explicit that it must not
be used for authentication — a shared device returns the same value to every user. It
is stored as an anti-alt signal only.

## Tips are verified on chain

The client reports a transaction hash. Nothing else it says is trusted.

`src/jobs/tipwatcher.js` polls a Nimiq node via `getTransactionByHash` and only
marks a tip verified once **all** of these hold: enough confirmations, the sender is
the tipper, the recipient is the person being tipped, the transaction carries the
marker `predtube tip m<marketId>` in its data, and it did not fail on chain.

**The amount is taken from the chain, not the request.** Claim 500 NIM and send 0.5,
and 0.5 is what gets recorded. Unverified tips count for nothing on a profile.

Tips are only allowed on resolved markets — the point is rewarding a proven call —
and a hash can only be submitted once. Node outages retry rather than failing the
tipper; a transaction that never lands is given up on after `TIP_MAX_ATTEMPTS`.

Set `NIMIQ_RPC_URL`, or nothing is ever verified.

## Still open
- Bounty payouts are recorded in `bounty_awards` but not sent. Needs a payout job and
  a funded app wallet, plus locking the bounty at creation rather than at settlement.
- No comments yet. Spec says they unlock after wagering.
- Alt accounts, self-dealing, and last-minute entry are knowingly unsolved.
  `device_hash` is stored and unused — it's the obvious first signal to reach for.
