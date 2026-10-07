import {hexToString, parseAbi, type Address, type Hex, type PublicClient} from "viem";

import {RETRY_DELAYS_MS, askPatiently} from "./client.js";

/**
 * What a token contract says about itself.
 *
 * `null` means the contract would not say, which is a different fact from it saying something
 * empty, and callers should not treat the two alike: a token with no readable symbol is not one
 * that can be checked for impersonating another, and reporting it as clean would be a claim
 * nothing established.
 */
export interface TokenIdentity {
  address: Address;
  symbol: string | null;
  name: string | null;
  /**
   * The endpoint refused to ask the contract, every time it was asked to. The symbol and name are
   * `null` then too, but not because the contract would not say: nobody asked it. Kept apart so a
   * screen does not blame the token for the endpoint.
   */
  unanswered?: true;
}

/**
 * Multicall3 lives at the same address on nearly every chain, which is why it can be named here
 * instead of read from a chain config that a client built from a bare URL does not have.
 */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const AS_STRING = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);
/** Older tokens — MKR is the well-known one — return these as `bytes32`, and decoding that as a string throws. */
const AS_BYTES32 = parseAbi(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);

/** Wide enough to be a handful of requests for a busy history, narrow enough for a public endpoint. */
const BATCH = 50;

type Call = {address: Address; abi: typeof AS_STRING | typeof AS_BYTES32; functionName: "symbol" | "name"};
type Answer = {status: "success"; result: unknown} | {status: "failure"; error: unknown};

/**
 * Read the symbol and name of every token contract in a list.
 *
 * This is the half of token checking that needs a network, and it lives here for the same reason
 * `scanHistory` does: the app and any other consumer must not each write their own version and
 * drift apart. Deciding what a symbol means is the engine's job, and this returns the raw strings
 * for it. The two are kept apart on purpose, so a symbol is never judged by code that also had a
 * reason to want a particular answer.
 *
 * Nothing here trusts a token. An address may not be a contract, may revert, may return the wrong
 * type, and may return a string that is hostile to whatever displays it — each of those yields
 * `null` or an ordinary string, never an exception, so one broken token cannot cost the user the
 * check on the other two hundred.
 *
 * Nor does it take a refusal for an answer. A batch the endpoint refuses is asked again, after a
 * pause; one it refuses every time comes back `unanswered`. An earlier version gave up on the
 * first refusal and left those tokens `null`, which the screen then reported as tokens that "would
 * not say what they are called" — the endpoint's refusal, told as a fact about the contracts.
 */
export async function readTokenIdentities(
  client: Pick<PublicClient, "multicall">,
  tokens: readonly Address[],
  options: {retryDelaysMs?: readonly number[]} = {},
): Promise<TokenIdentity[]> {
  const {retryDelaysMs = RETRY_DELAYS_MS} = options;
  const unique = [...new Set(tokens.map((token) => token.toLowerCase() as Address))];
  const identities = new Map<Address, TokenIdentity>(
    unique.map((address) => [address, {address, symbol: null, name: null}]),
  );
  const unanswered = new Set<Address>();

  // First the standard shape, then the legacy one for whatever refused it.
  const read = async (abi: Call["abi"], kind: "string" | "bytes32", addresses: Address[]) => {
    for (let start = 0; start < addresses.length; start += BATCH) {
      const slice = addresses.slice(start, start + BATCH);
      const calls: Call[] = slice.flatMap((address) => [
        {address, abi, functionName: "symbol" as const},
        {address, abi, functionName: "name" as const},
      ]);

      const answers = (await askPatiently(
        () => client.multicall({contracts: calls, allowFailure: true, multicallAddress: MULTICALL3}),
        retryDelaysMs,
      )) as Answer[] | undefined;
      if (answers === undefined) {
        // Refused every time. Those tokens stay unread, and say why, rather than failing the scan.
        for (const address of slice) unanswered.add(address);
        continue;
      }

      slice.forEach((address, i) => {
        const symbol = answers[i * 2];
        const name = answers[i * 2 + 1];
        const entry = identities.get(address)!;
        if (symbol?.status === "success") entry.symbol ??= decode(symbol.result, kind);
        if (name?.status === "success") entry.name ??= decode(name.result, kind);
      });
    }
  };

  await read(AS_STRING, "string", unique);
  // Only what answered and still gave no string: a token nobody could ask has nothing to retry yet.
  await read(
    AS_BYTES32,
    "bytes32",
    unique.filter((address) => identities.get(address)!.symbol === null && !unanswered.has(address)),
  );

  return [...identities.values()].map((identity) =>
    unanswered.has(identity.address) ? {...identity, unanswered: true as const} : identity,
  );
}

/**
 * What the contract returned, as text.
 *
 * Told which shape was asked for rather than guessing from the value, because the two are
 * indistinguishable that way: viem hands back a `bytes32` as a `0x…` string, which is also a
 * string. Deciding by `typeof` would return the raw hex as the symbol — and a legacy token such as
 * MKR would then be judged by 64 hex characters instead of by its name.
 */
export function decode(value: unknown, kind: "string" | "bytes32"): string | null {
  if (kind === "string") return typeof value === "string" ? value : null;
  if (!isHex(value) || value.length !== 66) return null;
  // Trailing zero bytes are padding, not part of the symbol.
  const text = hexToString(value, {size: 32}).replace(/\u0000+$/u, "");
  return text.length > 0 ? text : null;
}

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}
