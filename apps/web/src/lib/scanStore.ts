"use client";

import {useEffect, useState} from "react";
import type {Address} from "viem";

import {addressesEqual, type AddressSighting, type FlaggedToken} from "@truesend/engine";

const KEY = "truesend.last-scan";

/**
 * What a scan's token check came to, in the shape `matchFlaggedToken` reads back on Send.
 *
 * `checked` and `unreadable` are carried along only to show "N tokens checked" if Send ever wants
 * to; the two lists are the part that answers a question.
 */
export interface StoredTokenCheck {
  checked: number;
  unreadable: number;
  counterfeit: FlaggedToken[];
  unusual: FlaggedToken[];
}

export interface StoredScan {
  owner: Address;
  history: AddressSighting[];
  scannedAt: number;
  fromBlock: string;
  toBlock: string;
  /**
   * The token check for this same scan, attached once it finishes.
   *
   * Absent, not empty, until then — see `attachTokenCheck`. A caller that needs to tell "not
   * checked yet" from "checked and clean" has to look at this field rather than treat a missing
   * one as a clean bill.
   */
  tokenCheck?: StoredTokenCheck;
}

/**
 * Carry the last scan across to the screens that can spend.
 *
 * Without this the product has the shape of the attack in it: Scan knows an address has a
 * fabricated payment record, and Send — the screen where it matters — starts from nothing and
 * cheerfully reports "no history, normal for a first payment". Knowing something on one page and
 * forgetting it on the next is exactly the gap the attacker is working in.
 *
 * Session storage rather than local: a history summary is a map of who someone pays, and it has
 * no business outliving the tab. Everything here is plain numbers and strings, so it survives
 * `JSON` without a custom serialiser.
 */
export function saveScan(scan: StoredScan): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(scan));
  } catch {
    // Private browsing, a full quota, or storage switched off. The scan still displays; only the
    // hand-off to Send is lost, and Send says when it has nothing.
  }
}

export function loadScan(): StoredScan | undefined {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredScan) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attach a token check to the scan already stored for this owner.
 *
 * Why this is not just another field on `saveScan`'s argument: reading token identities is its
 * own round trip, slower than the scan and run after it, so by the time it resolves `saveScan` has
 * usually already run and Send may already have read what it wrote. Written on afterward instead,
 * and only when `owner` still matches the stored scan — if a newer scan has replaced it, this
 * result belongs to an account nobody is looking at any more, and attaching it to the wrong one
 * would be the exact bug this file exists to avoid.
 */
export function attachTokenCheck(owner: Address, tokenCheck: StoredTokenCheck): void {
  const current = loadScan();
  if (!current || !addressesEqual(current.owner, owner)) return;
  saveScan({...current, tokenCheck});
}

/** Reads once on mount, because session storage does not exist during server rendering. */
export function useLastScan(): StoredScan | undefined {
  const [scan, setScan] = useState<StoredScan | undefined>(undefined);
  useEffect(() => setScan(loadScan()), []);
  return scan;
}
