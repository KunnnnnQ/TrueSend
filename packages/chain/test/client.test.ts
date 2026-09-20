import {describe, expect, it} from "vitest";

import {splitOnRefusal, type BlockRange} from "../src/client.js";

const RANGE: BlockRange = {fromBlock: 100n, toBlock: 199n};

/**
 * The retry that keeps a scan from dying halfway.
 *
 * Log density is not something a caller can know in advance and the cap differs per provider, so
 * a fixed chunk size is either too big for a busy range or too slow for a quiet one. Halving on
 * refusal is what makes one chunk size work everywhere — and getting the *predicate* wrong is
 * worse than not retrying at all, because a genuine error would be retried into an infinite split.
 */
describe("splitOnRefusal", () => {
  it("passes the range straight through when the endpoint accepts it", async () => {
    const seen: BlockRange[] = [];
    const result = await splitOnRefusal(RANGE, async (part) => {
      seen.push(part);
      return ["ok"];
    });

    expect(result).toEqual(["ok"]);
    expect(seen).toEqual([RANGE]);
  });

  it("halves and retries when the endpoint says the window was too wide", async () => {
    const seen: BlockRange[] = [];
    const result = await splitOnRefusal(RANGE, async (part) => {
      seen.push(part);
      if (part.fromBlock === RANGE.fromBlock && part.toBlock === RANGE.toBlock) {
        throw new Error("query returned more than 10000 results");
      }
      return [`${part.fromBlock}-${part.toBlock}`];
    });

    expect(seen).toHaveLength(3);
    expect(result).toEqual(["100-149", "150-199"]);
  });

  it("keeps splitting until each piece is accepted", async () => {
    // Refuse anything wider than 25 blocks, which forces two rounds of halving.
    const accepted: BlockRange[] = [];
    await splitOnRefusal(RANGE, async (part) => {
      if (part.toBlock - part.fromBlock >= 25n) throw new Error("range too large");
      accepted.push(part);
      return [];
    });

    expect(accepted).toHaveLength(4);
    expect(accepted[0]?.fromBlock).toBe(100n);
    expect(accepted.at(-1)?.toBlock).toBe(199n);
  });

  it("covers the original range exactly, with no gap and no overlap", async () => {
    const covered: bigint[] = [];
    await splitOnRefusal(RANGE, async (part) => {
      if (part.toBlock - part.fromBlock >= 10n) throw new Error("exceeds limit");
      for (let block = part.fromBlock; block <= part.toBlock; block++) covered.push(block);
      return [];
    });

    expect(covered).toHaveLength(100);
    expect(new Set(covered).size).toBe(100);
    expect(covered[0]).toBe(100n);
    expect(covered.at(-1)).toBe(199n);
  });

  /**
   * The important negative. Retrying an error that is not about range would turn one bad request
   * into hundreds, and would hide the real failure behind a stack of splits.
   */
  it("does not retry an error that is not about the window", async () => {
    let calls = 0;
    await expect(
      splitOnRefusal(RANGE, async () => {
        calls++;
        throw new Error("invalid api key");
      }),
    ).rejects.toThrow("invalid api key");

    expect(calls).toBe(1);
  });

  it("gives up rather than splitting forever once a range cannot be halved", async () => {
    let calls = 0;
    await expect(
      splitOnRefusal({fromBlock: 10n, toBlock: 11n}, async () => {
        calls++;
        throw new Error("query returned more than 10000 results");
      }),
    ).rejects.toThrow(/more than 10000/);

    expect(calls).toBeLessThan(10);
  });
});
