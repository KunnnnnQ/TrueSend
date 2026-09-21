/**
 * Did value actually leave, or does a log merely say so?
 *
 * A `Transfer` log naming someone as sender, in a transaction they did not sign, is one of two
 * very different things:
 *
 *   - a **fabrication** — anyone can call a contract that emits a log naming anyone as the
 *     sender, which is how address poisoning plants a payment that never happened;
 *   - a **real movement a third party was authorised to make** — an intent settlement (CoW,
 *     UniswapX, 1inch Fusion) or an old approval being spent. The log names you, the transaction
 *     names them, and your tokens really did move.
 *
 * Telling them apart matters because calling a solver an attacker is exactly the false alarm that
 * gets a safety tool switched off, and a tool that is switched off protects nobody.
 *
 * The test here asks the token rather than guessing from the shape of things. An honest token's
 * balances move exactly as its logs say they do, so for a given block it compares the owner's
 * balance before and after against the net of every `Transfer` log in that block that touches
 * them. Four outcomes, of which only the first is "this really happened":
 *
 *   - `stateAgrees`    — the books match the logs. Value left. Not a fabrication, whoever signed.
 *   - `stateDisagrees` — the logs claim a movement the balances do not show. Fabricated.
 *   - `noBalance`      — the contract will not answer `balanceOf`, or answers with something that
 *                        is not a balance. Fabricated: these logs come from something that keeps
 *                        no books.
 *   - `unknown`        — an endpoint failed. Never guessed at; excluded from every count.
 *
 * **This needs archive state, which the product does not have** — public endpoints serve recent
 * state only. It is ground truth for measurement, not a rule that can ship. Its job is to score
 * the rules that *can* ship, which see only logs and signatures.
 *
 * What it cannot see: a fake token that keeps honest books — mint to the victim, then move the
 * minted amount out through a backdoor — reconciles perfectly and reads as real. Anything this
 * calls real should be listed and looked at, not trusted in bulk.
 *
 * Calibrated against two records whose nature is already established, by `check-reconcile.mjs`.
 */

import {TRANSFER_TOPIC, addressFromTopic} from "./rpc.mjs";

const BALANCE_OF = "0x70a08231";
/** A 32-byte word. Anything else is not a balance and not an amount. */
const WORD = /^0x[0-9a-f]{64}$/i;

/**
 * @param client a client from `createClient` pointed at an **archive** endpoint.
 * @param owner the address the records name as sender.
 * @param records `{token, txHash}` — nonzero unsigned outgoing transfers. Zero-value records need
 *   no reconciling: nothing moved, so nothing can have been paid.
 * @returns a Map from each record to `{verdict, calling}`, where `calling` is the contract the
 *   transaction called, kept because it says what kind of thing moved the tokens.
 */
export async function reconcile(client, owner, records) {
  const verdicts = new Map();
  if (records.length === 0) return verdicts;

  const me = owner.toLowerCase();
  const hex = (n) => `0x${n.toString(16)}`;

  const hashes = [...new Set(records.map((r) => r.txHash))];
  const txs = await client.batchSettled("eth_getTransactionByHash", hashes.map((h) => [h]));

  const txInfo = new Map();
  hashes.forEach((hash, i) => {
    const tx = txs[i].ok ? txs[i].result : null;
    if (tx?.blockNumber) {
      txInfo.set(hash, {
        block: Number.parseInt(tx.blockNumber, 16),
        calling: tx.to ? tx.to.toLowerCase() : null,
      });
    }
  });

  // One reconciliation per (token, block). Several records can share a block and they share its
  // answer; reading the same balance twice only costs the endpoint patience.
  const keyOf = (token, block) => `${token}@${block}`;
  const keys = new Map();
  for (const record of records) {
    const info = txInfo.get(record.txHash);
    if (info) keys.set(keyOf(record.token, info.block), {token: record.token, block: info.block});
  }

  const list = [...keys.values()];
  const balanceOfMe = `${BALANCE_OF}${me.slice(2).padStart(64, "0")}`;

  const [before, after, blockLogs] = await Promise.all([
    client.batchSettled(
      "eth_call",
      list.map(({token, block}) => [{to: token, data: balanceOfMe}, hex(block - 1)]),
    ),
    client.batchSettled(
      "eth_call",
      list.map(({token, block}) => [{to: token, data: balanceOfMe}, hex(block)]),
    ),
    client.batchSettled(
      "eth_getLogs",
      list.map(({token, block}) => [
        {address: token, topics: [TRANSFER_TOPIC], fromBlock: hex(block), toBlock: hex(block)},
      ]),
    ),
  ]);

  const byKey = new Map();
  list.forEach(({token, block}, i) => {
    byKey.set(keyOf(token, block), verdictFor(me, before[i], after[i], blockLogs[i]));
  });

  for (const record of records) {
    const info = txInfo.get(record.txHash);
    verdicts.set(record, {
      verdict: info ? byKey.get(keyOf(record.token, info.block)) ?? "unknown" : "unknown",
      calling: info?.calling ?? null,
      block: info?.block ?? null,
    });
  }

  return verdicts;
}

/** Exported for the calibration script; not useful on its own. */
export function verdictFor(me, before, after, blockLogs) {
  // A contract that refuses `balanceOf` is not keeping books, which is itself an answer. A node
  // that could not be reached is not, and must never be read as one.
  if (before.refused || after.refused) return "noBalance";
  if (!before.ok || !after.ok || !blockLogs.ok) return "unknown";

  const held = WORD.test(before.result) ? BigInt(before.result) : null;
  const holds = WORD.test(after.result) ? BigInt(after.result) : null;
  if (held === null || holds === null) return "noBalance";

  let logged = 0n;
  for (const log of blockLogs.result) {
    // Three topics is the ERC-20 shape. A fourth means an indexed third argument — an NFT's token
    // id, say — where the number in the log is an identity, not an amount, and cannot be summed.
    if (log.removed || log.topics.length !== 3) continue;
    const value = WORD.test(log.data) ? BigInt(log.data) : 0n;
    if (addressFromTopic(log.topics[2]) === me) logged += value;
    if (addressFromTopic(log.topics[1]) === me) logged -= value;
  }

  return holds - held === logged ? "stateAgrees" : "stateDisagrees";
}
