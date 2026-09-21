import {describe, expect, it} from "vitest";
import type {Address, PublicClient} from "viem";

import {accountKind, canSignOwnTransactions, classifyAccount} from "../src/account.js";

const DELEGATE = "3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
/** What EIP-7702 writes: `0xef0100 || address`, twenty-three bytes and not one more. */
const DELEGATED = `0xef0100${DELEGATE}`;
/** The opening of any compiled contract: free memory pointer, then a dispatcher. */
const CONTRACT_CODE = "0x6080604052348015600e575f80fd5b50600436106030575f3560e01c";

/**
 * Which of three things an address is, and the whole detector turns on getting it right.
 *
 * Call a contract account an EOA and every payment its owner ever made reads as a fabrication —
 * and worse, `assessAddress` builds its payee set from payments, so the lookalike rule stops
 * firing entirely. Call a delegated EOA a contract and the signer test is dropped for an account
 * that does sign, which is the one thing that must not happen to the users this project asks to
 * install a delegation.
 */
describe("classifyAccount", () => {
  it("calls an account with no code an EOA", () => {
    expect(classifyAccount("0x")).toBe("eoa");
  });

  it("calls a missing answer an EOA, which keeps the strict signer test", () => {
    expect(classifyAccount(undefined)).toBe("eoa");
    expect(classifyAccount(null)).toBe("eoa");
    expect(classifyAccount("")).toBe("eoa");
  });

  /**
   * Including an account running this project's own `GuardedAccount`. A delegated EOA is still an
   * EOA and still signs, and EIP-7702 says as much: these are the accounts permitted to originate
   * transactions.
   */
  it("calls an EIP-7702 delegation designator a delegated EOA", () => {
    expect(classifyAccount(DELEGATED)).toBe("delegated-eoa");
    expect(classifyAccount(DELEGATED.toUpperCase().replace("0X", "0x"))).toBe("delegated-eoa");
  });

  it("calls real bytecode a contract", () => {
    expect(classifyAccount(CONTRACT_CODE)).toBe("contract");
  });

  /**
   * The designator is an exact shape, not a prefix. Anything else with code "may not originate
   * transactions", so a near miss has to fall to `contract` — treating it as a delegated EOA
   * would restore the signer test to an account that can never pass it.
   */
  it("does not accept a near miss as a delegation", () => {
    expect(classifyAccount(`0xef0100${DELEGATE.slice(0, 38)}`)).toBe("contract");
    expect(classifyAccount(`0xef0100${DELEGATE}00`)).toBe("contract");
    expect(classifyAccount(`0xef0101${DELEGATE}`)).toBe("contract");
    expect(classifyAccount(`0xef01${DELEGATE}`)).toBe("contract");
    expect(classifyAccount(`0xef0100${DELEGATE.slice(0, 39)}z`)).toBe("contract");
  });
});

describe("canSignOwnTransactions", () => {
  it("is true for both kinds of externally owned account", () => {
    expect(canSignOwnTransactions("eoa")).toBe(true);
    expect(canSignOwnTransactions("delegated-eoa")).toBe(true);
  });

  it("is false only for a contract, which can never be tx.from", () => {
    expect(canSignOwnTransactions("contract")).toBe(false);
  });
});

describe("accountKind", () => {
  const clientReturning = (code: string) =>
    ({getCode: async () => code}) as unknown as PublicClient;

  it("asks the chain once and classifies the answer", async () => {
    expect(await accountKind(clientReturning(CONTRACT_CODE), "0x1" as Address)).toBe("contract");
    expect(await accountKind(clientReturning(DELEGATED), "0x1" as Address)).toBe("delegated-eoa");
  });

  /**
   * A node having a bad minute must not quietly change what the detector means. Falling back to
   * `eoa` keeps the strict signer test, which can only raise a warning that should not have
   * fired — never silence one that should.
   */
  it("falls back to the conservative answer when the node will not say", async () => {
    const broken = {
      getCode: async () => {
        throw new Error("rate limited");
      },
    } as unknown as PublicClient;

    expect(await accountKind(broken, "0x1" as Address)).toBe("eoa");
  });
});
