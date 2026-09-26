import {describe, expect, it, vi} from "vitest";
import type {Address, PublicClient} from "viem";

import {decode, readTokenIdentities} from "../src/tokens.js";

const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
/** `MKR` as a `bytes32`, right-padded with zeros, which is how an old token returns its symbol. */
const MKR_BYTES32 = `0x4d4b52${"00".repeat(29)}` as const;

type Answer = {status: "success"; result: unknown} | {status: "failure"; error: Error};
const ok = (result: unknown): Answer => ({status: "success", result});
const fail = (): Answer => ({status: "failure", error: new Error("execution reverted")});

/**
 * A node that answers from a table. The first pass asks for `string`, the second for `bytes32`,
 * and which one is being asked is read off the ABI, exactly as a real node would answer it.
 */
function node(table: Record<string, {string?: [unknown, unknown]; bytes32?: [unknown, unknown]}>) {
  const multicall = vi.fn(async ({contracts}: {contracts: {address: Address; abi: readonly {outputs: readonly {type: string}[]}[]}[]}) => {
    const kind = contracts[0]!.abi[0]!.outputs[0]!.type as "string" | "bytes32";
    return contracts.map((call, i) => {
      const entry = table[call.address.toLowerCase()]?.[kind];
      if (!entry) return fail();
      return ok(entry[i % 2]);
    });
  });
  return {client: {multicall} as unknown as Pick<PublicClient, "multicall">, multicall};
}

describe("readTokenIdentities", () => {
  it("reads the symbol and name of an ordinary token", async () => {
    const {client} = node({[at(1)]: {string: ["USDT", "Tether USD"]}});
    expect(await readTokenIdentities(client, [at(1)])).toEqual([{address: at(1), symbol: "USDT", name: "Tether USD"}]);
  });

  /**
   * MKR and a few others return `bytes32`. Decoding that as a string throws, and reading it as
   * text without decoding gives back the hex — so this is the case that quietly turns a legitimate
   * old token into 64 characters of garbage that any symbol check would then condemn.
   */
  it("reads a legacy bytes32 symbol as text, not as the hex it arrives in", async () => {
    const {client} = node({[at(2)]: {bytes32: [MKR_BYTES32, MKR_BYTES32]}});
    const [mkr] = await readTokenIdentities(client, [at(2)]);

    expect(mkr?.symbol).toBe("MKR");
    expect(mkr?.symbol).not.toMatch(/^0x/);
  });

  it("returns null rather than an empty answer for a token that will not say", async () => {
    const {client} = node({});
    expect(await readTokenIdentities(client, [at(3)])).toEqual([{address: at(3), symbol: null, name: null}]);
  });

  it("passes a hostile symbol through untouched, for the engine to judge and the UI to defuse", async () => {
    const hostile = "USDT‮឴";
    const {client} = node({[at(4)]: {string: [hostile, "x"]}});
    const [token] = await readTokenIdentities(client, [at(4)]);

    expect(token?.symbol).toBe(hostile);
  });

  it("keeps going when one token in a batch is broken", async () => {
    const {client} = node({[at(5)]: {string: ["DAI", "Dai"]}, [at(7)]: {string: ["WETH", "Wrapped Ether"]}});
    const result = await readTokenIdentities(client, [at(5), at(6), at(7)]);

    expect(result.map((r) => r.symbol)).toEqual(["DAI", null, "WETH"]);
  });

  it("does not throw when the endpoint refuses a whole batch", async () => {
    const client = {
      multicall: async () => {
        throw new Error("request entity too large");
      },
    } as unknown as Pick<PublicClient, "multicall">;

    await expect(readTokenIdentities(client, [at(8), at(9)])).resolves.toEqual([
      {address: at(8), symbol: null, name: null},
      {address: at(9), symbol: null, name: null},
    ]);
  });

  it("asks once per token however many times a history mentions it, whatever its case", async () => {
    const {client, multicall} = node({[at(10)]: {string: ["USDC", "USD Coin"]}});
    const upper = at(10).toUpperCase().replace("0X", "0x") as Address;

    const result = await readTokenIdentities(client, [at(10), upper, at(10)]);

    expect(result).toHaveLength(1);
    // Two calls (symbol, name) for one token, and no legacy retry because the first pass answered.
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall.mock.calls[0]![0].contracts).toHaveLength(2);
  });

  it("splits a long history into batches an ordinary endpoint will accept", async () => {
    const addresses = Array.from({length: 130}, (_, i) => at(1000 + i));
    const table = Object.fromEntries(addresses.map((a) => [a, {string: ["T", "Token"] as [unknown, unknown]}]));
    const {client, multicall} = node(table);

    await readTokenIdentities(client, addresses);

    // 130 tokens at 50 a batch is three requests, each of at most 100 calls.
    expect(multicall).toHaveBeenCalledTimes(3);
    for (const call of multicall.mock.calls) expect(call[0].contracts.length).toBeLessThanOrEqual(100);
  });
});

describe("decode", () => {
  it("returns a string answer as it is", () => {
    expect(decode("USDT", "string")).toBe("USDT");
  });

  it("does not mistake a bytes32 for a string just because both arrive as JavaScript strings", () => {
    expect(decode(MKR_BYTES32, "bytes32")).toBe("MKR");
    // Read as a string it is the hex, which is the bug this parameter exists to prevent.
    expect(decode(MKR_BYTES32, "string")).toBe(MKR_BYTES32);
  });

  it("refuses anything that is not the shape asked for", () => {
    expect(decode(42, "string")).toBeNull();
    expect(decode("0x1234", "bytes32")).toBeNull();
    expect(decode(undefined, "bytes32")).toBeNull();
  });

  it("treats an all-zero bytes32 as nothing rather than as an empty symbol", () => {
    expect(decode(`0x${"00".repeat(32)}`, "bytes32")).toBeNull();
  });
});
