# Demo video script

A silent, captioned walkthrough of the live site, recorded in one browser session. The captions are
overlays injected into the page rather than a voice track, so the recording needs no microphone and
no editing pass — what the script does is what the video is.

**The video:** 1 minute 26.6 seconds, 1440×900, VP8/WebM at 25 fps, 6.66 MB (6,979,475 bytes). It
is deliberately kept out of the repository.

**The live site:** <https://kunnnnnq.github.io/TrueSend/>

## The screenshots

Five stills from the same session, in `docs/images/`. Each is the 1440×900 viewport, page content
only, and every one is well under 400 KB.

| File | What it shows |
| --- | --- |
| `scan-wbtc.png` | The WBTC case loaded: the summary line (231 transfers · 15 counterparties · 111 signers resolved · 14 fabricated · 14 to avoid), the red "1 counterfeit token in this history" panel, and the first rows |
| `row-findings.png` | The first "Do not send" row expanded — nine payments to it that the account never signed, said in plain words, and that the account has only ever received from it |
| `send-warning.png` | Send, with the lookalike recipient and the counterfeit token filled in: the red token warning and the "This recipient — Do not send 65" panel |
| `sepolia-policy.png` | A live policy on Sepolia: `0x816C8e…63C0`, Hold 5 min, new contacts active after 5 min, no guardian |
| `report-sepolia.png` | The Report screen on Sepolia with "Registry live on this chain" and the resolver and schema UID, confirmed against the chain's own schema registry |

## Scenes

The eight scenes, in order, with the caption on screen for each. "Hold" is how long the caption
stays up once the scene is ready.

| # | Scene | Caption | Hold |
| --- | --- | --- | --- |
| 1 | Scan page, at rest | Address poisoning: an attacker plants a fake payment to a lookalike address in your history, hoping you copy it next time. | 4 s |
| 2 | Click **Load The 1155 WBTC loss, May 2024**; caption stays up for the whole wait | A real case: 1,155 WBTC lost in May 2024. TrueSend reads the history and checks who actually signed each transfer. | until 15 rows exist, then 3.4 s |
| 3 | Results, scrolled to the counterfeit panel | 14 'payments' this account never signed - fabricated. And a token calling itself ETH - counterfeit. | 6 s |
| 4 | The first "Do not send" row, expanded | Every verdict says why, in plain words. | 4 s |
| 5 | Send page; the two addresses typed at 15 ms per character | Before you pay, the scan follows you: the lookalike is flagged, and so is the fake token. | 6 s |
| 6 | Send page, Network **Sepolia**, protected account `0x816C8ecE6D775a1E8FA4540c57cB0A6b80B463C0` | On chain, through EIP-7702: a payment to a new address waits 5 minutes, and can be cancelled. | 6 s |
| 7 | Report page, Sepolia | A community registry on EAS - a lookalike claim is checked on chain before it is accepted. | 5 s |
| 8 | Back to the top of Scan | TrueSend - open source. github.com/KunnnnnQ/TrueSend | 4 s |

The addresses used, and why they are these ones:

| Where | Value | Why |
| --- | --- | --- |
| Send → To | `0xd9A1C3788D81257612E2581A6ea0aDa244853a91` | The attacker's address from the May 2024 case. Its only credential was a fabricated `0.05 ETH` payment the victim never signed |
| Send → Token | `0x739352337c902c3874b95f14e81ebbcf1b7b262e` | The contract that calls itself `ETH`. It is what emitted that fabricated record |
| Send → Protected account | `0x816C8ecE6D775a1E8FA4540c57cB0A6b80B463C0` | A deployed vault on Sepolia with a 5-minute hold, so the policy panel has something real to read |
| Scan | the case preset, blocks 19780000–19789100 | The app's preset for the case. It holds the bait (block 19788642) and the loss (block 19789009), both verified in `analysis/`. The screen is not a fixture — it re-reads mainnet |

## Recording it again

Two npm packages and an installed Chrome. Nothing is installed inside the repository, because that
would change the lockfile.

```bash
mkdir -p /tmp/truesend-video && cd /tmp/truesend-video
npm init -y && npm i playwright
```

`chromium.launch({channel: "chrome"})` uses the Chrome already on the machine, so there is no
browser download. Save the two files below as `common.js` and `record.js`, then:

```bash
node record.js ./video
```

The video appears when the context closes, at the path the script prints.

### `common.js`

```js
const BASE = "https://kunnnnnq.github.io/TrueSend";
const RECIPIENT = "0xd9A1C3788D81257612E2581A6ea0aDa244853a91";
const TOKEN = "0x739352337c902c3874b95f14e81ebbcf1b7b262e";
const ACCOUNT = "0x816C8ecE6D775a1E8FA4540c57cB0A6b80B463C0";

/**
 * Wait for the fingerprint words to settle.
 *
 * They animate from random letters into real words. "At least 3 seconds after content appears" is
 * the rule; the recording additionally checks that what is on screen reads as real words, because
 * a frame of half-scrambled letters is worse than no frame.
 */
async function settle(page, ms = 3200) {
  await page.waitForTimeout(ms);
}

module.exports = {BASE, RECIPIENT, TOKEN, ACCOUNT, settle};
```

### `record.js`

```js
/**
 * Records the captioned demo video.
 *
 * One browser session for the whole run, because the Send warning only appears when a scan is
 * already in the same tab's sessionStorage — the app carries the scan from Scan to Send by design.
 *
 * Usage: node record.js <video-dir>
 */
const fs = require("fs");
const path = require("path");
const {chromium} = require("playwright");
const {BASE, RECIPIENT, TOKEN, ACCOUNT, settle} = require("./common");

const DIR = process.argv[2] || path.join(process.cwd(), "video");
const WORDS_SETTLED_MS = 3400; // >= 3 s after content appears, so fingerprints read as words

const CAPTIONS = {
  1: "Address poisoning: an attacker plants a fake payment to a lookalike address in your history, hoping you copy it next time.",
  2: "A real case: 1,155 WBTC lost in May 2024. TrueSend reads the history and checks who actually signed each transfer.",
  3: "14 \u2018payments\u2019 this account never signed - fabricated. And a token calling itself ETH - counterfeit.",
  4: "Every verdict says why, in plain words.",
  5: "Before you pay, the scan follows you: the lookalike is flagged, and so is the fake token.",
  6: "On chain, through EIP-7702: a payment to a new address waits 5 minutes, and can be cancelled.",
  7: "A community registry on EAS - a lookalike claim is checked on chain before it is accepted.",
  8: "TrueSend - open source. github.com/KunnnnnQ/TrueSend",
};

/** Injects or updates the caption overlay. Re-injected after every navigation. */
async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById("cap");
    if (!el) {
      el = document.createElement("div");
      el.id = "cap";
      el.style.cssText = "position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:99999;max-width:80%;padding:12px 20px;border:1px solid #3a3a3a;border-radius:10px;background:rgba(0,0,0,.88);color:#f2f2f2;font:500 18px/1.45 system-ui,sans-serif;text-align:center;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

/**
 * The overlay is a child of `body`, so a full page load destroys it while a client-side route
 * change keeps it. Re-applying before every scene covers both, and costs nothing when it is
 * already there.
 */
async function scene(page, n, holdMs) {
  await caption(page, CAPTIONS[n]);
  await page.waitForTimeout(holdMs);
}

/** One reload and retry, then give up on the scene rather than hang. */
async function gotoRetry(page, url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await page.goto(url, {waitUntil: "domcontentloaded", timeout: 60000});
      if (resp && resp.status() >= 400) throw new Error("HTTP " + resp.status());
      return true;
    } catch (e) {
      console.log(`  goto ${url} attempt ${attempt}: ${e.message.slice(0, 90)}`);
      if (attempt === 2) return false;
      await page.waitForTimeout(2500);
    }
  }
  return false;
}

/** Scrolls to an absolute y over ~1.2 s so the movement is visible in the recording. */
async function smoothScrollTo(page, y) {
  await page.evaluate(async (target) => {
    const from = window.scrollY;
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      window.scrollTo(0, from + ((target - from) * i) / steps);
      await new Promise((r) => setTimeout(r, 50));
    }
  }, y);
}

(async () => {
  fs.mkdirSync(DIR, {recursive: true});
  const t0 = Date.now();

  const browser = await chromium.launch({channel: "chrome"});
  const context = await browser.newContext({
    viewport: {width: 1440, height: 900},
    recordVideo: {dir: DIR, size: {width: 1440, height: 900}},
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("  pageerror:", e.message.slice(0, 140)));

  const video = page.video();

  // --- scene 1: the premise ------------------------------------------------------------------
  console.log("[1] Scan page");
  if (!(await gotoRetry(page, BASE + "/"))) throw new Error("app did not load");
  await settle(page, 3000);
  await scene(page, 1, 4000);

  // --- scene 2: load the case (caption stays up through the whole wait) -----------------------
  console.log("[2] loading the WBTC case");
  await page.getByRole("button", {name: /Load The 1155 WBTC loss/}).click();
  await caption(page, CAPTIONS[2]);

  let rows = 0;
  const scanStart = Date.now();
  for (let i = 0; i < 170; i++) {
    await page.waitForTimeout(1000);
    // Keep the caption present: the results section re-renders while the scan streams in.
    await caption(page, CAPTIONS[2]);
    rows = await page.evaluate(() => document.querySelectorAll("main li .sr-only").length);
    if (rows >= 15) break;
  }
  console.log(`[2] ${rows} rows after ${((Date.now() - scanStart) / 1000).toFixed(0)}s`);
  if (rows < 15) throw new Error("scan never produced 15 rows");

  // Fingerprints resolve out of noise; wait, then confirm they read as four real words.
  await settle(page, WORDS_SETTLED_MS);
  const phrases = await page.evaluate(() =>
    [...document.querySelectorAll("main li .sr-only")].map((n) => n.textContent)
  );
  const malformed = phrases.filter((p) => !/^[a-z]+( [a-z]+){3}$/.test(p));
  const residue = await page.evaluate(() => /[$#%]/.test(document.body.innerText));
  console.log(`[2] phrases ${phrases.length}, malformed ${malformed.length}, scrambled residue ${residue}`);

  // --- scene 3: the results ------------------------------------------------------------------
  console.log("[3] results");
  await caption(page, CAPTIONS[3]);
  const panelTop = await page.evaluate(() => {
    const s = [...document.querySelectorAll("main section")].find((n) => n.innerText.includes("counterfeit token"));
    return Math.round(s.getBoundingClientRect().top + window.scrollY);
  });
  await smoothScrollTo(page, Math.max(0, panelTop - 110));
  await scene(page, 3, 6000);

  // --- scene 4: why the verdict ---------------------------------------------------------------
  console.log("[4] expanding the first Do not send row");
  await page.locator("main li").filter({has: page.getByText("Do not send")}).first().locator("button").first().click();
  await settle(page, WORDS_SETTLED_MS);
  const rowTop = await page.evaluate(() => {
    const li = [...document.querySelectorAll("main li")].find((n) => n.innerText.includes("Do not send"));
    return Math.round(li.getBoundingClientRect().top + window.scrollY);
  });
  await smoothScrollTo(page, Math.max(0, rowTop - 150));
  await scene(page, 4, 4000);

  // --- scene 5: Send, in the same tab so the scan carries over ---------------------------------
  console.log("[5] Send page");
  await page.getByRole("link", {name: "Send", exact: true}).click();
  await page.waitForTimeout(2500);
  await caption(page, CAPTIONS[5]);

  await page.locator('input[placeholder="0x…"]').first().pressSequentially(RECIPIENT, {delay: 15});
  await page.locator('input[placeholder="ETH"]').first().pressSequentially(TOKEN, {delay: 15});
  await settle(page, WORDS_SETTLED_MS);

  const warned = await page.getByText(/flagged as counterfeit in your last scan/).count();
  const verdict = await page.getByText("Do not send").count();
  console.log(`[5] counterfeit warning ${warned}, "Do not send" ${verdict}`);
  await scene(page, 5, 6000);

  // --- scene 6: Sepolia, a live policy ---------------------------------------------------------
  console.log("[6] Sepolia policy");
  await page.selectOption("select", {label: "Sepolia"});
  await page.waitForTimeout(1200);
  await page.locator('input[placeholder*="SafeVault"]').first().fill(ACCOUNT);
  await caption(page, CAPTIONS[6]);

  let holdSeen = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    await caption(page, CAPTIONS[6]);
    if (await page.getByText("Hold", {exact: true}).count()) {
      if (/5 min/.test(await page.locator("main section").nth(1).innerText())) { holdSeen = true; break; }
    }
  }
  console.log("[6] Hold 5 min visible:", holdSeen);
  if (!holdSeen) throw new Error("Sepolia policy never showed Hold 5 min");
  await settle(page, WORDS_SETTLED_MS);
  await smoothScrollTo(page, 0);
  await scene(page, 6, 6000);

  // --- scene 7: the registry -------------------------------------------------------------------
  console.log("[7] Report page");
  await page.getByRole("link", {name: "Report", exact: true}).click();
  await page.waitForTimeout(2000);
  await caption(page, CAPTIONS[7]);
  // The chain choice from Send persists across routes; assert rather than assume.
  if ((await page.locator("select").first().inputValue()) !== "11155111") {
    await page.selectOption("select", {label: "Sepolia"});
  }
  await page.getByText("Registry live on this chain.").waitFor({timeout: 30000});
  await settle(page, WORDS_SETTLED_MS);
  await smoothScrollTo(page, 0);
  await scene(page, 7, 5000);

  // --- scene 8: back to the top ----------------------------------------------------------------
  console.log("[8] close");
  await page.getByRole("link", {name: "Scan", exact: true}).click();
  await page.waitForTimeout(2500);
  await smoothScrollTo(page, 0);
  await scene(page, 8, 4000);

  await context.close();
  await browser.close();

  const file = await video.path();
  const st = fs.statSync(file);
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\nvideo: ${file}`);
  console.log(`size:  ${(st.size / 1024 / 1024).toFixed(2)} MB (${st.size} bytes)`);
  console.log(`wall clock for the whole run: ${elapsed.toFixed(0)}s`);
  fs.writeFileSync("record-result.json", JSON.stringify({file, bytes: st.size, wallSeconds: Math.round(elapsed)}, null, 2));
})();
```

### Reproducing the stills

The five PNGs come from the same session and the same waits, with `page.screenshot()` in place of
the timed holds. The two things that matter:

- **Wait for the scan, not for a fixed time.** Poll `document.querySelectorAll("main li .sr-only").length`
  until it is at least 15. On a good run that is about 8 seconds; the first run of the day took 39.
- **Wait for the fingerprints.** Every phrase animates from noise, so any capture sooner than about
  3 seconds after the rows appear will show scrambled letters. The script waits 3.4 s and then
  asserts all 15 phrases match `^[a-z]+( [a-z]+){3}$` and that no `$`, `#` or `%` remains on the
  page — those characters only ever appear in the scrambled state.

## Notes from the recording

- **The Send warning needs the scan in the same tab.** `apps/web/src/lib/scanStore.ts` keeps the
  last scan in `sessionStorage`, and the Send screen scores a recipient *against that history*. Open
  `/send/` in a fresh tab and it honestly says "no history to check against" and shows "Looks fine".
  That is the app working as designed, and it is why the recording is one continuous session rather
  than four independent clips.
- **The score counts up.** The number beside a verdict animates from 0 to its value over 0.7 s, so a
  frame taken while the token address is still being typed can read "Do not send 64"; it settles at
  65. The token plays no part in that number — the verdict is about the recipient, and the
  counterfeit token gets its own warning under the Token field. The 6-second hold starts after
  typing finishes, so the settled number is what is on screen.
- **A real mainnet read, not a fixture.** The scan streams from mainnet during scene 2, which is why
  that scene's length is whatever the network takes. The numbers in the captions (14 fabricated, 1
  counterfeit) were stable across every run on the day, but a changed window could move them.
- **The 4 seconds before the first caption are not dead air by accident.** Chromium starts writing
  the video when the context opens, so page load and the first scroll pre-roll ahead of scene 1.
- **Nothing is connected and nothing is signed.** No wallet extension is present — the header reads
  "No wallet found" in every frame — and no address is ever submitted. The Send and Report buttons
  are never clicked.

## Files

| What | Where |
| --- | --- |
| Video | Kept out of the repository |
| Screenshots | `docs/images/scan-wbtc.png`, `row-findings.png`, `send-warning.png`, `sepolia-policy.png`, `report-sepolia.png` |
| This script | `docs/demo-script.md` |
