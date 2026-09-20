import {describe, expect, it} from "vitest";

import {judge} from "../src/guard.js";

const ALICE = "0xab58c49b70d5e2f1a0c9f3d7e6b4a2c8d1f00e93";
/** Ground out to share Alice's first six and last four characters. */
const POISONED = "0xab58c41122334455667788990011223344ff0e93";
const BOB = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
const CAROL = "0x9d7d8b567ee10bcb4f9db438245e1d0668175d72";
/** Shares eight leading characters with Carol, so it is a *stronger* collision than Alice's. */
const CAROL_FAKE = "0x9d7d8b56aabbccddeeff00112233445566175d72";

describe("an ordinary address", () => {
  it("gets its fingerprint and nothing alarming", () => {
    const verdict = judge({address: BOB});

    expect(verdict.level).toBe("neutral");
    expect(verdict.headline).toBe(verdict.fingerprint.phrase);
    expect(verdict.lookalike).toBeUndefined();
  });

  it("stays neutral next to unrelated addresses on the page", () => {
    expect(judge({address: BOB, onPage: [ALICE, CAROL]}).level).toBe("neutral");
  });
});

describe("an address that has been altered", () => {
  /** A broken checksum is the one signal here that costs nothing and has no false positives. */
  it("is flagged before anything else is considered", () => {
    const verdict = judge({address: "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"});

    expect(verdict.level).toBe("danger");
    expect(verdict.headline).toContain("altered");
  });

  it("does not complain about an address written in one case", () => {
    expect(judge({address: ALICE}).level).toBe("neutral");
    expect(judge({address: ALICE.toUpperCase().replace("0X", "0x")}).level).toBe("neutral");
  });
});

describe("two addresses on the same page", () => {
  it("is flagged as a fact about the screen, not a guess", () => {
    const verdict = judge({address: POISONED, onPage: [ALICE, POISONED, BOB]});

    expect(verdict.level).toBe("danger");
    expect(verdict.headline).toContain("this page");
    expect(verdict.lookalike?.address).toBe(ALICE);
    expect(verdict.lookalike?.source).toBe("page");
  });

  it("names how much the two share", () => {
    const verdict = judge({address: POISONED, onPage: [ALICE]});

    expect(verdict.lookalike?.sharedPrefix).toBe(6);
    expect(verdict.lookalike?.sharedSuffix).toBe(4);
    expect(verdict.detail).toContain("first 6 and last 4");
  });

  it("gives the two different fingerprints to compare", () => {
    const verdict = judge({address: POISONED, onPage: [ALICE]});
    expect(verdict.lookalike?.fingerprint.phrase).not.toBe(verdict.fingerprint.phrase);
  });

  /**
   * The bug this guards against: pairs come back strongest-first, and the strongest pair on a
   * page may be between two addresses that have nothing to do with the one being judged. Taking
   * the first pair blindly meant a real warning was silently dropped whenever some other pair on
   * the page happened to match more closely.
   */
  it("is still flagged when a stronger collision elsewhere on the page outranks it", () => {
    const verdict = judge({
      address: POISONED,
      onPage: [ALICE, POISONED, CAROL, CAROL_FAKE],
    });

    expect(verdict.level).toBe("danger");
    expect(verdict.lookalike?.address).toBe(ALICE);
  });

  it("says nothing when the only collision is between two other addresses", () => {
    expect(judge({address: BOB, onPage: [CAROL, CAROL_FAKE]}).level).toBe("neutral");
  });

  it("does not treat the address appearing twice as a collision", () => {
    expect(judge({address: ALICE, onPage: [ALICE, ALICE]}).level).toBe("neutral");
  });
});

describe("an address that imitates one you saved", () => {
  it("outranks the page check and names the contact", () => {
    const verdict = judge({
      address: POISONED,
      onPage: [POISONED],
      saved: [{address: ALICE, label: "Alice"}],
    });

    expect(verdict.level).toBe("danger");
    expect(verdict.headline).toBe("This is not Alice");
    expect(verdict.lookalike?.source).toBe("saved");
  });

  it("works without a label", () => {
    const verdict = judge({address: POISONED, saved: [{address: ALICE}]});

    expect(verdict.headline).toContain("imitates an address you saved");
    expect(verdict.lookalike?.address).toBe(ALICE);
  });

  it("leaves the saved address itself alone", () => {
    expect(judge({address: ALICE, saved: [{address: ALICE, label: "Alice"}]}).level).toBe(
      "neutral",
    );
  });

  it("picks the saved contact over an equally close one on the page", () => {
    const verdict = judge({
      address: POISONED,
      onPage: [ALICE, POISONED],
      saved: [{address: ALICE, label: "Alice"}],
    });

    expect(verdict.lookalike?.source).toBe("saved");
  });
});
