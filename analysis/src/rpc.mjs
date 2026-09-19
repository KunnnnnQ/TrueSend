/**
 * A minimal JSON-RPC client, deliberately dependency-free.
 *
 * The analysis has to be reproducible by anyone who clones this repo, which means it cannot
 * depend on an API key or a paid plan. Free endpoints differ in what they serve: most public
 * nodes prune history, so the 2024 case study needs one of the few that answers archive queries.
 * The endpoint lists below record which is which, because working that out took a while and is
 * not discoverable from any of their documentation.
 */

/** Serve recent blocks. Fine for anything within the last few days. */
export const RECENT_ENDPOINTS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://rpc.mevblocker.io",
];

/**
 * Answer `eth_getLogs` against old blocks on a free plan.
 *
 * Checked 2026-09-20: publicnode returns "Archive requests require a personal token", drpc
 * returns a misleading "ranges over 10000 blocks are not supported" for *any* range at an old
 * block, and llamarpc, cloudflare, ankr, blockpi, flashbots and 1rpc are either gated, rate
 * limited to a handful of blocks, or down.
 */
export const ARCHIVE_ENDPOINTS = ["https://rpc.mevblocker.io"];

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const TOKENS = {
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
};

/** Left-pad an address into a 32-byte log topic. */
export function topicFor(address) {
  return `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
}

/** Recover an address from a 32-byte log topic. */
export function addressFromTopic(topic) {
  return `0x${topic.slice(26)}`.toLowerCase();
}

export function createClient(endpoints, {timeoutMs = 25_000, retries = 3} = {}) {
  let cursor = 0;
  let id = 0;

  async function post(body, endpoint) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(method, params) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const endpoint = endpoints[(cursor + attempt) % endpoints.length];
      try {
        const result = await post({jsonrpc: "2.0", id: ++id, method, params}, endpoint);
        if (result.error) {
          lastError = new Error(`${endpoint}: ${result.error.message}`);
          continue;
        }
        cursor = (cursor + attempt) % endpoints.length;
        return result.result;
      } catch (error) {
        lastError = error;
      }
      await sleep(600 * (attempt + 1));
    }
    throw lastError ?? new Error(`${method} failed`);
  }

  /**
   * Batch several calls into one request.
   *
   * Checking who signed a transaction is one call per transaction, and a scan turns up thousands.
   * Without batching the scan takes long enough that nobody re-runs it, and an analysis nobody
   * re-runs stops being evidence.
   */
  async function batch(method, paramsList, {chunkSize = 100} = {}) {
    const out = new Array(paramsList.length);
    for (let start = 0; start < paramsList.length; start += chunkSize) {
      const slice = paramsList.slice(start, start + chunkSize);
      const body = slice.map((params, i) => ({
        jsonrpc: "2.0",
        id: start + i,
        method,
        params,
      }));

      let responses;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const endpoint = endpoints[(cursor + attempt) % endpoints.length];
        try {
          const parsed = await post(body, endpoint);
          if (Array.isArray(parsed)) {
            responses = parsed;
            break;
          }
        } catch {
          // fall through to the next endpoint
        }
        await sleep(600 * (attempt + 1));
      }

      if (!responses) {
        // Some endpoints refuse batches outright. One at a time is slower but always works.
        for (let i = 0; i < slice.length; i++) {
          out[start + i] = await call(method, slice[i]).catch(() => null);
        }
        continue;
      }

      for (const response of responses) {
        out[response.id] = response.error ? null : response.result;
      }
    }
    return out;
  }

  async function getLogs(filter) {
    return call("eth_getLogs", [filter]);
  }

  /**
   * Walk a block range, splitting whenever an endpoint says the window was too wide.
   *
   * Log density is not something a caller can know up front: USDT alone runs tens of thousands of
   * transfers an hour and the cap differs per provider. Guessing a fixed chunk size means either
   * a scan that dies halfway or one that crawls, so the range halves itself on the specific
   * "too many results" and "range too large" errors and retries.
   */
  async function getLogsRange(filter, fromBlock, toBlock, {chunk = 200, minChunk = 1, onChunk} = {}) {
    const logs = [];

    async function fetchSpan(start, end) {
      try {
        const page = await getLogs({
          ...filter,
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
        });
        logs.push(...page);
        onChunk?.(end, logs.length);
      } catch (error) {
        const tooWide = /more than \d+ results|exceeds limit|too large|range|limited to/i.test(
          error?.message ?? "",
        );
        if (!tooWide || end - start < minChunk) throw error;
        const middle = Math.floor((start + end) / 2);
        await fetchSpan(start, middle);
        await fetchSpan(middle + 1, end);
      }
    }

    for (let start = fromBlock; start <= toBlock; start += chunk) {
      await fetchSpan(start, Math.min(start + chunk - 1, toBlock));
    }
    return logs;
  }

  async function blockNumber() {
    return Number.parseInt(await call("eth_blockNumber", []), 16);
  }

  return {call, batch, getLogs, getLogsRange, blockNumber};
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
