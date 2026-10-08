import {readFileSync} from "node:fs";

import type {Page, Route} from "@playwright/test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  numberToHex,
  pad,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";

/**
 * Mainnet, as far as the page can tell: every answer an endpoint gave about the May 2024 preset,
 * served in the browser so the tests need no network.
 *
 * The recording is the one the chain package's replay reads (`packages/chain/test/fixtures/`,
 * written by `packages/chain/scripts/record-scan.mjs`). It is answered at the very URL the live demo
 * calls, so the page under test is the page that ships, built the way Pages builds it, asking what
 * it always asks.
 */

interface RecordedLog {
  token: Address;
  from: Address;
  to: Address;
  value: string;
  blockNumber: number;
  transactionHash: Hex;
  logIndex: number;
}

interface Recording {
  toBlock: number;
  code: Hex;
  signers: Record<string, Address>;
  blockTimes: Record<string, number>;
  tokens: {address: Address; symbol: string | null; name: string | null}[];
  logs: RecordedLog[];
}

const recording: Recording = JSON.parse(
  readFileSync(new URL("../../../packages/chain/test/fixtures/wbtc-2024-05-03.json", import.meta.url), "utf8"),
);

/** `HISTORY_RPC` for mainnet when `NEXT_PUBLIC_MAINNET_RPC` is not set, as on the live demo. */
const ENDPOINT = "rpc.mevblocker.io";
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const SELECTORS = {symbol: "0x95d89b41", name: "0x06fdde03"} as const;

const topic = (address: string) => pad(address.toLowerCase() as Hex, {size: 32});
const blockHash = (block: number) => pad(numberToHex(block), {size: 32});

interface Call {
  id: number;
  method: string;
  params: unknown[];
}

type Answer = {result: unknown} | {error: {code: number; message: string}};

/** Transactions whose lookup the endpoint refuses every time, the way a rate limit does. */
export interface Refusals {
  transactions?: readonly string[];
}

function answer(call: Call, refuse: Refusals): Answer {
  switch (call.method) {
    case "eth_getLogs": {
      const [filter] = call.params as [{fromBlock: Hex; toBlock: Hex; topics?: (Hex | null)[]}];
      const [event, from, to] = filter.topics ?? [];
      // The recording holds Transfer logs and nothing else, so any other event has none.
      if (event && event.toLowerCase() !== TRANSFER) return {result: []};
      const first = Number(BigInt(filter.fromBlock));
      const last = Number(BigInt(filter.toBlock));
      return {
        result: recording.logs
          .filter((log) => log.blockNumber >= first && log.blockNumber <= last)
          .filter((log) => !from || topic(log.from) === from.toLowerCase())
          .filter((log) => !to || topic(log.to) === to.toLowerCase())
          .map((log) => ({
            address: log.token,
            topics: [TRANSFER, topic(log.from), topic(log.to)],
            data: numberToHex(BigInt(log.value), {size: 32}),
            blockNumber: numberToHex(log.blockNumber),
            blockHash: blockHash(log.blockNumber),
            blockTimestamp: numberToHex(recording.blockTimes[String(log.blockNumber)] ?? 0),
            transactionHash: log.transactionHash,
            transactionIndex: "0x0",
            logIndex: numberToHex(log.logIndex),
            removed: false,
          })),
      };
    }

    case "eth_getTransactionByHash": {
      const hash = String(call.params[0]).toLowerCase();
      if (refuse.transactions?.includes(hash)) {
        return {error: {code: -32005, message: "limit exceeded (refused by the test)"}};
      }
      const from = recording.signers[hash];
      const log = recording.logs.find((entry) => entry.transactionHash === hash);
      if (!from || !log) return {result: null};
      return {
        result: {
          hash,
          from,
          to: null,
          blockNumber: numberToHex(log.blockNumber),
          blockHash: blockHash(log.blockNumber),
          transactionIndex: "0x0",
          nonce: "0x0",
          gas: "0x5208",
          gasPrice: "0x1",
          value: "0x0",
          input: "0x",
          type: "0x0",
          chainId: "0x1",
          v: "0x25",
          r: "0x1",
          s: "0x1",
        },
      };
    }

    case "eth_getBlockByNumber": {
      const block = Number(BigInt(String(call.params[0])));
      const time = recording.blockTimes[String(block)];
      if (time === undefined) return {result: null};
      return {result: {number: numberToHex(block), hash: blockHash(block), timestamp: numberToHex(time), transactions: []}};
    }

    case "eth_getCode":
      return {result: recording.code};

    // Token names, asked through Multicall3's aggregate3: the same answers the recording holds.
    case "eth_call": {
      const [request] = call.params as [{data: Hex}];
      const {functionName, args} = decodeFunctionData({abi: multicall3Abi, data: request.data});
      if (functionName !== "aggregate3") return {error: {code: -32000, message: `${functionName} is not recorded`}};
      const results = args[0].map(({target, callData}) => {
        const token = recording.tokens.find((entry) => entry.address === target.toLowerCase());
        const selector = callData.slice(0, 10);
        const said =
          selector === SELECTORS.symbol ? token?.symbol : selector === SELECTORS.name ? token?.name : undefined;
        return said == null
          ? {success: false, returnData: "0x" as Hex}
          : {success: true, returnData: encodeAbiParameters([{type: "string"}], [said])};
      });
      return {result: encodeFunctionResult({abi: multicall3Abi, functionName: "aggregate3", result: results})};
    }

    case "eth_chainId":
      return {result: "0x1"};

    case "eth_blockNumber":
      return {result: numberToHex(recording.toBlock)};

    default:
      return {error: {code: -32601, message: `${call.method} is not in the recording`}};
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * Answer the live demo's mainnet endpoint from the recording, and refuse everything else that
 * would leave this machine — a test that quietly depended on the network would pass or fail on the
 * day's weather, not on the code.
 */
export async function replayMainnet(page: Page, refuse: Refusals = {}): Promise<void> {
  await page.route(
    (url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    (route) => route.abort(),
  );
  await page.route(
    (url) => url.hostname === ENDPOINT,
    async (route: Route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({status: 204, headers: CORS});
        return;
      }
      const body = route.request().postDataJSON() as Call | Call[];
      const calls = Array.isArray(body) ? body : [body];
      const replies = calls.map((call) => ({jsonrpc: "2.0", id: call.id, ...answer(call, refuse)}));
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(body) ? replies : replies[0]),
      });
    },
  );
}
