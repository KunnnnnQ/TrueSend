import {describe, expect, it} from "vitest";

import {assessMany, checkTokens, counterparties, type RiskAssessment} from "@truesend/engine";

import {scanHistory} from "../src/history.js";
import {KNOWN_TOKENS} from "../src/known-tokens.js";
import {LISTED_TOKENS} from "../src/token-list.js";
import recorded from "./fixtures/wbtc-2024-05-03.json";
import {replay, type Recording, type ReplayOptions} from "./replay.js";

/**
 * The live demo's preset — the May 2024 WBTC loss — replayed from what mainnet actually said.
 *
 * `fixtures/wbtc-2024-05-03.json` holds every answer an endpoint gave about the victim over the
 * preset's range: 231 transfers, who signed each of their 111 transactions, when each block was,
 * and what each token calls itself. `scripts/record-scan.mjs` wrote it, reading the chain directly
 * rather than through `scanHistory`, so a mistake in the scan cannot also be in the recording.
 *
 * This exists because of a regression the other tests let through. The first version of the
 * copied-payment exemption looked right in every unit test and in `analysis/`'s replay, which
 * builds this case's history by hand and leaves out the loss itself — and on the live demo it
 * called the attacker "Looks fine", because scanned past the loss, the 1155 WBTC is a payment the
 * victim signed. Nothing caught it but loading the preset by hand. Now the whole Scan screen runs
 * on the real records here, on every push.
 */
const recording = recorded as Recording;

const ATTACKER = "0xd9a1c3788d81257612e2581a6ea0ada244853a91";
/** The bait: a token calling itself `ETH`, and a record of the victim paying the attacker 0.05 of it. */
const BAIT_TOKEN = "0x739352337c902c3874b95f14e81ebbcf1b7b262e";
const BAIT_TX = "0x9147d74ef5749b7f27eb2e2528e5a611060b3f609b435f7f50ac87f49e5b957c";
/** The only counterparty that ever paid the victim: 114 deliveries of the WBTC they were buying. */
const SELLER = "0xa88800cd213da5ae406ce248380802bd53b47647";
/** The block before the loss, which is when the victim would have wanted this screen. */
const BEFORE_THE_LOSS = 19_789_008;

/**
 * What the Scan screen does with a range, in the order it does it (`apps/web/src/app/page.tsx`):
 * scan, assess every counterparty against the history, and check every token it saw.
 */
async function scanScreen(options: ReplayOptions = {}, toBlock = recording.toBlock) {
  const {client, asked} = replay(recording, options);
  const result = await scanHistory(
    client,
    recording.owner,
    {fromBlock: BigInt(recording.fromBlock), toBlock: BigInt(toBlock)},
    {knownTokens: KNOWN_TOKENS[1] ?? [], retryDelaysMs: [0, 0]},
  );

  const now = result.transfers.reduce((latest, t) => Math.max(latest, t.at), 0);
  const verdicts = assessMany(counterparties(result.history), {history: result.history, now});
  const tokens = checkTokens(
    result.owner,
    result.transfers,
    recording.tokens.filter((token) => result.tokensSeen.includes(token.address)),
    {
      canonical: (KNOWN_TOKENS[1] ?? []).map(({symbol, address}) => ({symbol, address})),
      listed: LISTED_TOKENS[1] ?? [],
    },
  );

  return {result, verdicts, tokens, asked};
}

const verdictOf = (verdicts: readonly RiskAssessment[], address: string) =>
  verdicts.find((v) => v.address.toLowerCase() === address);

/** Address, level, score and reasons: the whole table, for comparing one run with another. */
const table = (verdicts: readonly RiskAssessment[]) =>
  verdicts.map((v) => [v.address, v.level, v.score, v.findings.map((f) => f.code)]);

describe("the May 2024 WBTC case, replayed from mainnet's answers", () => {
  it("shows what the live demo shows: fourteen addresses to avoid, the attacker among them", async () => {
    const {result, verdicts} = await scanScreen();

    expect(result.transfers).toHaveLength(231);
    expect(result.unchecked).toEqual([]);
    expect(result.signersResolved).toBe(111);
    expect(verdicts).toHaveLength(15);
    expect(verdicts.filter((v) => v.level === "danger")).toHaveLength(14);

    const attacker = verdictOf(verdicts, ATTACKER);
    expect(attacker?.level).toBe("danger");
    expect(attacker?.score).toBe(65);
    expect(attacker?.findings.map((f) => f.code)).toEqual(["spoofed-outgoing-transfer"]);
  });

  it("condemns every one of the fourteen for a payment the victim never signed", async () => {
    const {verdicts} = await scanScreen();

    for (const verdict of verdicts.filter((v) => v.level === "danger")) {
      expect(verdict.findings[0]?.code, verdict.address).toBe("spoofed-outgoing-transfer");
    }
  });

  it("leaves the one address that only ever paid the victim alone", async () => {
    const {verdicts} = await scanScreen();

    expect(verdictOf(verdicts, SELLER)?.level).toBe("safe");
  });

  it("calls the bait's token counterfeit, and nothing the victim really held", async () => {
    const {tokens} = await scanScreen();

    expect(tokens.counterfeit.map((t) => t.address)).toEqual([BAIT_TOKEN]);
    expect(tokens.counterfeit[0]?.findings.map((f) => f.issue)).toEqual(["impersonates-native-asset"]);
    expect(tokens.counterfeit[0]).toMatchObject({planted: 1, forged: 1});
    expect(tokens.unusual).toEqual([]);
    expect(tokens.unreadable).toBe(0);
  });

  it("calls the attacker what it was before the loss: a fabricated payment, never paid", async () => {
    const {verdicts} = await scanScreen({}, BEFORE_THE_LOSS);
    const attacker = verdictOf(verdicts, ATTACKER);

    expect(attacker?.level).toBe("danger");
    expect(attacker?.findings.map((f) => f.code)).toEqual(["spoofed-outgoing-transfer", "never-paid-before"]);
  });
});

describe("the same case, when the endpoint misbehaves", () => {
  it("reaches the same verdicts from an endpoint that does not put times on its logs", async () => {
    const timed = await scanScreen();
    const untimed = await scanScreen({logsCarryBlockTime: false});

    expect(timed.asked.blocks).toBe(0);
    expect(untimed.asked.blocks).toBe(77);
    expect(table(untimed.verdicts)).toEqual(table(timed.verdicts));
  });

  it("reaches the same verdicts when the bait's lookup is refused once and then answered", async () => {
    const clean = await scanScreen();
    const refusedOnce = await scanScreen({refuse: {transactions: {[BAIT_TX]: 1}}});

    expect(refusedOnce.result.unchecked).toEqual([]);
    expect(table(refusedOnce.verdicts)).toEqual(table(clean.verdicts));
  });

  /**
   * The failure this replaced. Simulated against live mainnet before the fix, refusing this one
   * lookup made the attacker "Looks fine 0", and the screen said "110 signers resolved" with no
   * sign that a 111th was missing.
   */
  it("does not call the attacker fine when the bait's lookup is refused every time", async () => {
    const {result, verdicts, tokens} = await scanScreen({refuse: {transactions: {[BAIT_TX]: Infinity}}});
    const attacker = verdictOf(verdicts, ATTACKER);

    expect(result.unchecked.map((u) => u.txHash)).toEqual([BAIT_TX]);
    expect(attacker?.level).toBe("caution");
    expect(attacker?.findings.map((f) => f.code)).toEqual(["unchecked-records"]);
    // The bait's token is still named for what it is: its name needs no signature.
    expect(tokens.counterfeit.map((t) => t.address)).toEqual([BAIT_TOKEN]);
  });

  it("and before the loss, does not call the attacker a first payment either", async () => {
    const {verdicts} = await scanScreen({refuse: {transactions: {[BAIT_TX]: Infinity}}}, BEFORE_THE_LOSS);
    const codes = verdictOf(verdicts, ATTACKER)?.findings.map((f) => f.code);

    expect(codes).toEqual(["unchecked-records"]);
    expect(codes).not.toContain("no-history-at-all");
  });
});
