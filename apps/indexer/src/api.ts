import {createServer, type Server} from "node:http";

import {isAddress, type Address, type PublicClient} from "viem";

import {scanHistory} from "@truesend/chain";
import {assessAddress, checkAddressFormat, foldHistory, type AddressSighting} from "@truesend/engine";

import type {Store} from "./store.js";
import type {Watcher} from "./watcher.js";

export interface ApiOptions {
  store: Store;
  watcher: Watcher;
  chainId: number;
  client: PublicClient;
  /** How far back a history request looks when the caller does not say. */
  defaultLookback: bigint;
}

/**
 * A small HTTP surface, on Node's own server.
 *
 * No framework. There are six routes, none of them needs middleware, and a router dependency here
 * would be more code to audit than the thing it routes.
 */
export function createApi(options: ApiOptions): Server {
  const {store, watcher, chainId, client, defaultLookback} = options;

  return createServer((request, response) => {
    void handle(request.method ?? "GET", request.url ?? "/", readBody(request))
      .then(({status, body}) => {
        const payload = JSON.stringify(body, bigintSafe, 2);
        response.writeHead(status, {
          "content-type": "application/json",
          // The web app runs on a different origin in development, and this API exposes nothing
          // an attacker could not read from the chain themselves.
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type",
        });
        response.end(payload);
      })
      .catch((error: unknown) => {
        response.writeHead(500, {"content-type": "application/json"});
        response.end(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
      });
  });

  async function handle(
    method: string,
    url: string,
    body: Promise<unknown>,
  ): Promise<{status: number; body: unknown}> {
    const parsed = new URL(url, "http://localhost");
    const path = parsed.pathname.replace(/\/+$/, "") || "/";

    if (method === "OPTIONS") return {status: 204, body: {}};

    if (path === "/health") {
      return {
        status: 200,
        body: {
          ok: true,
          chainId,
          cursor: store.getCursor(chainId) ?? null,
          watching: store.watched(chainId).length,
        },
      };
    }

    // Everything being watched, and what is on hold right now.
    if (path === "/watch" && method === "GET") {
      return {
        status: 200,
        body: store.watched(chainId).map((row) => ({
          ...row,
          open: store.queue(chainId, row.policy, true).length,
        })),
      };
    }

    if (path === "/watch" && method === "POST") {
      const payload = (await body) as {policy?: string};
      if (!payload?.policy || !isAddress(payload.policy)) {
        return {status: 400, body: {error: "Body must be {\"policy\": \"0x…\"}"}};
      }

      const result = await watcher.addPolicy(payload.policy as Address);
      return result.watched
        ? {status: 200, body: {watching: payload.policy.toLowerCase()}}
        : {status: 404, body: {error: result.reason}};
    }

    if (path.startsWith("/queue/")) {
      const policy = path.slice("/queue/".length).toLowerCase();
      if (!isAddress(policy)) return {status: 400, body: {error: "Not an address"}};
      const onlyOpen = parsed.searchParams.get("all") !== "1";
      return {status: 200, body: store.queue(chainId, policy, onlyOpen)};
    }

    if (path.startsWith("/alerts/")) {
      const policy = path.slice("/alerts/".length).toLowerCase();
      if (!isAddress(policy)) return {status: 400, body: {error: "Not an address"}};
      return {status: 200, body: store.alerts(chainId, policy)};
    }

    /**
     * Score one recipient.
     *
     * The caller may send a folded history, or an owner to build one for. Both paths run the same
     * engine the web app and the extension run, so a verdict here is the verdict a user sees.
     */
    if (path === "/risk" && method === "POST") {
      const payload = (await body) as {
        to?: string;
        owner?: string;
        history?: AddressSighting[];
        now?: number;
      };
      if (!payload?.to) {
        return {status: 400, body: {error: "Body must include a `to` address"}};
      }

      // A bad checksum is a finding, not a formatting complaint: a mixed-case address whose
      // capitalisation does not match its own hash has been altered between the sender and here.
      // Answering "that is not an address" would throw that away.
      const format = checkAddressFormat(payload.to);
      if (format === "not-an-address") {
        return {status: 400, body: {error: "`to` is not a 20-byte hex address"}};
      }
      if (format === "bad-checksum") {
        return {
          status: 400,
          body: {
            error: "checksum-mismatch",
            detail:
              "This address is the right shape but its checksum does not match. It has been " +
              "altered or mistyped somewhere. Do not use it — ask the recipient again.",
          },
        };
      }

      let history = payload.history;
      if (!history && payload.owner && isAddress(payload.owner)) {
        history = (await historyFor(payload.owner as Address)).history;
      }

      return {
        status: 200,
        body: assessAddress({
          to: payload.to,
          ...(history ? {history} : {}),
          ...(payload.now ? {now: payload.now} : {}),
        }),
      };
    }

    // The folded history for an address, signers resolved. This is the expensive one.
    if (path.startsWith("/history/")) {
      const owner = path.slice("/history/".length).toLowerCase();
      if (!isAddress(owner)) return {status: 400, body: {error: "Not an address"}};

      const blocks = parsed.searchParams.get("blocks");
      const result = await historyFor(owner as Address, blocks ? BigInt(blocks) : undefined);
      return {
        status: 200,
        body: {
          owner,
          fromBlock: result.range.fromBlock,
          toBlock: result.range.toBlock,
          signersResolved: result.signersResolved,
          // Transfers the endpoint would not let the scan check. Nonzero means the history below is
          // incomplete; the addresses involved carry `uncheckedCount`.
          unchecked: result.unchecked.length,
          counterparties: result.history.length,
          fabricated: result.history.filter((entry) => entry.spoofedOutgoingCount > 0).length,
          history: result.history,
        },
      };
    }

    return {status: 404, body: {error: `No route for ${method} ${path}`}};
  }

  async function historyFor(owner: Address, lookback?: bigint) {
    const head = await client.getBlockNumber();
    const span = lookback ?? defaultLookback;
    const fromBlock = head > span ? head - span : 0n;
    return scanHistory(client, owner, {fromBlock, toBlock: head});
  }
}

/** `JSON.stringify` refuses bigints outright; every amount and block number here is one. */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function readBody(request: {on: (event: string, listener: (chunk?: Buffer) => void) => void}): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk?: Buffer) => chunk && chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
  });
}

export {foldHistory};
