# Indexer and alerts

A hold nobody hears about is a delay. A hold somebody hears about within a minute, with a cancel
link in the message, is a defence. This is the component that turns one into the other.

```bash
CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 \
WATCH=0xYourVault \
corepack pnpm --filter @truesend/indexer dev
```

It polls for holds starting and ending, tells the owner and the guardian once per channel, and
serves a small API the app and the extension can ask questions of.

## What it guarantees

**An alert is never sent twice, and a failure is never dropped.** Every send is recorded against
`(chain, policy, transfer, channel)` whether it worked or not. A delivered alert is never repeated,
a failed one is retried on the next poll, and a channel that keeps failing is given up on after a
cap rather than retrying forever. The asymmetry is deliberate: missing an alert is the failure that
matters, because the user has stopped watching for themselves on the strength of a promise this
component made. A duplicate is merely annoying.

**A restart resumes exactly where it stopped.** The cursor is on disk and advances only once
everything in a window is durable. A crash between the two repeats the window, which the alert
table makes harmless; a crash the other way round would skip it, and nothing would notice.

**It cannot miss a transfer because a log was dropped.** Queue ids are dense and monotonic — an
invariant the contracts assert — so the queue can always be rebuilt by walking `1..nextTransferId`
rather than by trusting an event stream to be complete.

**It does not alert about a hold that has already been resolved.** A transfer that was queued and
cancelled inside one poll window ends up closed rather than reported. Telling someone about a
problem they already dealt with is how a channel gets muted, and a muted channel protects nobody.

Seventeen tests cover exactly these, in `test/alerts.test.ts`.

## Why polling

A websocket subscription is lower latency and the wrong tool. When one drops it reconnects at the
head and silently skips whatever happened while it was away. For a component whose entire job is
to not miss one event, resumability beats latency — and the thing being waited for runs for hours,
so a few seconds either way changes nothing.

## Confirmations

Indexing runs a couple of blocks behind the head, so a transfer removed by a reorg is never
reported. The hold lasts hours; a minute of latency costs nothing, while a false alarm costs the
only thing this channel has.

A local chain is the exception and gets zero, which is correct rather than convenient: anvil has
no reorgs, and because it only mines when there is a transaction, any lag means the head never
moves far enough for anything to become "safe" and nothing is ever indexed at all.

## Channels

| | |
| --- | --- |
| `console` | Always on. A watcher with nothing configured still leaves a record somebody can read. |
| `telegram` | Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. One POST, no SDK. |
| `webhook` | Set `ALERT_WEBHOOK_URL`. The escape hatch for everything not built in. |

The message is written to be read on a phone lock screen, and carries the recipient's fingerprint
as **text** rather than a picture, because a phrase survives a notification preview and an image
does not. When a history is available it also carries the engine's reasons, so the alert says why
rather than only what.

```
── Transfer held — 5 ETH ───────────────────────────────────────
5 ETH is on hold, not sent.

To   0xd9A1C3…3a91
     scrub assist first parent
Unlocks  2026-09-21 07:59 UTC

If you did not mean this, cancel it:
http://localhost:3000/pending?chain=31337&policy=0x8458…8d80&id=2

You can cancel right up until it is executed, including after the hold ends.
────────────────────────────────────────────────────────────────
```

The link carries the account, the chain and the transfer id, so the person who just got the alert
lands on the cancel button rather than on a form to fill in.

## API

| | |
| --- | --- |
| `GET /health` | Chain, cursor, how many accounts are watched. |
| `GET /watch` | Watched accounts and how many holds are open on each. |
| `POST /watch` | `{"policy": "0x…"}`. Refuses an address with no TrueSend policy on it. |
| `GET /queue/:policy` | Open holds. `?all=1` includes settled ones. |
| `GET /alerts/:policy` | What was sent, when, and what failed. |
| `POST /risk` | `{to, history?, owner?, now?}` → the engine's verdict. |
| `GET /history/:owner` | Folded history with signers resolved. The expensive one. |

`/risk` distinguishes an address that is not an address from one whose **checksum does not
match**. The second is a finding rather than a formatting complaint: a mixed-case address whose
capitalisation disagrees with its own hash has been altered somewhere between the sender and here.
Answering "that is not an address" to both would throw away the one signal in this system that
costs nothing and has no false positives.

## What it does not do

**It does not index the whole chain.** Per-user history is built on demand and cached per request.
Globally indexing every ERC-20 transfer so that any address can be queried instantly is a real
piece of infrastructure, and pretending a hackathon has one would be architecture theatre. The
on-demand path is a few RPC calls because logs are filtered by the user's address on the node.

**It has no accounts, no auth and no delivery guarantees beyond one process.** Every endpoint
returns what anyone could read from the chain themselves, which is why CORS is open. A deployment
serving more than one user would need the owner to prove who they are before `/history/:owner`
could be trusted not to be a surveillance endpoint.

**It is one process with a SQLite file.** That is the right size for this, and it is worth saying
plainly rather than implying a cluster.

## Configuration

| | |
| --- | --- |
| `CHAIN_ID` | Default 31337. |
| `RPC_URL` | Falls back to a public endpoint for known chains. |
| `WATCH` | Comma-separated policies to pick up at boot, so a restart needs no manual step. |
| `PORT` | Default 4000. |
| `APP_URL` | Where the cancel links point. Default `http://localhost:3000`. |
| `DB_PATH` | Default `truesend.db`. |
| `POLL_SECONDS` | Default 12. |
| `CONFIRMATIONS` | Default 2, or 0 on a local chain. |
| `HISTORY_BLOCKS` | How far back a history scan looks. Default 50000. |
