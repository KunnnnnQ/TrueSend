"use client";

import {revealSymbol, type FlaggedToken} from "@truesend/engine";

export type {FlaggedToken} from "@truesend/engine";

export type TokenCheck =
  | {status: "idle"}
  | {status: "checking"; total: number}
  | {
      status: "done";
      checked: number;
      unreadable: number;
      counterfeit: FlaggedToken[];
      unusual: FlaggedToken[];
    }
  | {status: "failed"; message: string};

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/**
 * The tokens in a history that are not what they say.
 *
 * Address poisoning is not only about addresses. The bait in the May 2024 case was a token
 * contract calling itself `ETH`, and on one real account being poisoned on 2026-09-26, sixteen of
 * the seventeen token contracts in its last hundred thousand blocks were counterfeits: eleven
 * posing as USDT in four spellings and five posing as ETH. The seventeenth was the real USDT. A
 * wallet shows whichever name the contract chose, so the name tells the user nothing; the code
 * points and the contract do.
 *
 * Two tiers, because one was measured to be wrong. A rule that flags every symbol outside ASCII
 * catches the whole class of exotic-alphabet fakes, and also, run over a list of about six thousand
 * Ethereum tokens, meme tokens whose only fault is a Chinese ticker or an emoji. So a token is
 * called counterfeit when it
 * claims to be a specific real asset, or when it was planted in this account's history; a token that
 * is only spelled strangely is said to be unusual, in a line and not an alarm.
 *
 * Kept apart from the counterparty list because it answers a different question. That list asks
 * which addresses to avoid paying; this asks which of the things in the history were never real.
 */
export function CounterfeitTokens({check}: {check: TokenCheck}) {
  if (check.status === "idle") return null;

  if (check.status === "checking") {
    return (
      <p className="text-xs text-muted">
        Checking what {check.total} token {plural(check.total, "contract")} call themselves…
      </p>
    );
  }

  if (check.status === "failed") {
    return (
      <p className="text-xs text-caution">
        Could not read the token names ({check.message}). The counterparties below do not depend on
        it.
      </p>
    );
  }

  const {counterfeit, unusual, checked, unreadable} = check;

  return (
    <div className="space-y-3">
      {counterfeit.length > 0 ? (
        <section className="rise rounded-lg border border-danger/30 bg-surface p-4">
          <h2 className="text-sm font-medium text-danger">
            <span className="tabular">{counterfeit.length}</span> counterfeit{" "}
            {plural(counterfeit.length, "token")} in this history
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
            Each of these contracts calls itself something it is not, or was planted in this
            history by someone else. Anyone can deploy a token and choose its name — the contract
            address is the only part that cannot be copied.
          </p>

          <ul className="mt-3 space-y-2.5">
            {counterfeit.map((token) => (
              <TokenRow key={token.address} token={token} />
            ))}
          </ul>
        </section>
      ) : null}

      {unusual.length > 0 ? (
        <section className="rise rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-medium text-caution">
            <span className="tabular">{unusual.length}</span> {plural(unusual.length, "token")} with{" "}
            {unusual.length === 1 ? "a symbol that is" : "symbols that are"} not ordinary text
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
            Usually a meme coin or a project written in another alphabet; occasionally something
            worse. Nothing here was planted in this history, so it is not called counterfeit — check
            the contract, not the name.
          </p>
          <ul className="mt-3 space-y-2.5">
            {unusual.map((token) => (
              <TokenRow key={token.address} token={token} />
            ))}
          </ul>
        </section>
      ) : null}

      {counterfeit.length === 0 && unusual.length === 0 ? (
        <p className="text-xs text-muted">
          <span className="tabular text-text">{checked}</span> token {plural(checked, "contract")}{" "}
          checked — none pose as another asset.
          {unreadable > 0 ? (
            <>
              {" "}
              <span className="tabular">{unreadable}</span> would not say what they are called,
              which is not the same as being fine.
            </>
          ) : null}
        </p>
      ) : unreadable > 0 ? (
        <p className="text-xs text-muted">
          <span className="tabular">{unreadable}</span> other token{" "}
          {plural(unreadable, "contract")} would not say what they are called, which is not the same
          as being fine.
        </p>
      ) : null}
    </div>
  );
}

function TokenRow({token}: {token: FlaggedToken}) {
  return (
    <li className="rounded-md border border-line bg-ink px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* Code points, not the string: two of the characters in these are invisible, and a symbol
            can carry a right-to-left override that reorders the text around it. */}
        <code className="tabular text-sm text-text">{revealSymbol(token.symbol)}</code>
        <span className="tabular text-xs text-faint">
          {token.transfers} {plural(token.transfers, "transfer")}
        </span>
        {token.planted > 0 ? (
          <span className="tabular text-xs text-danger">
            {token.planted} planted by someone else
          </span>
        ) : null}
        <span className="tabular text-xs text-faint" title={token.address}>
          {token.address.slice(0, 8)}…{token.address.slice(-6)}
        </span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {token.findings.slice(0, 2).map((finding) => (
          <li key={finding.issue} className="text-sm leading-relaxed text-text/90">
            {finding.message}
          </li>
        ))}
      </ul>
    </li>
  );
}
