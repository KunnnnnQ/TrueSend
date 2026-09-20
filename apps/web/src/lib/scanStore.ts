"use client";

import {useEffect, useState} from "react";
import type {Address} from "viem";

import type {AddressSighting} from "@truesend/engine";

const KEY = "truesend.last-scan";

export interface StoredScan {
  owner: Address;
  history: AddressSighting[];
  scannedAt: number;
  fromBlock: string;
  toBlock: string;
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

/** Reads once on mount, because session storage does not exist during server rendering. */
export function useLastScan(): StoredScan | undefined {
  const [scan, setScan] = useState<StoredScan | undefined>(undefined);
  useEffect(() => setScan(loadScan()), []);
  return scan;
}
