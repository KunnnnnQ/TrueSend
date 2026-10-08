import {expect, test, type Page} from "@playwright/test";

import {replayMainnet} from "./mainnet";

/**
 * The live demo's Scan screen, in a real browser, on the May 2024 case.
 *
 * `packages/chain/test/wbtc-case.test.ts` already holds the verdicts to account on every push. This
 * holds the page to them: the same recording, through the static export Pages publishes, read the
 * way a visitor reads it. Until 2026-10-07 the page was wider than any phone and cut off the very
 * verdicts that test was guarding, and no test could have noticed.
 */

const ATTACKER = "0xd9A1C3";
const BAIT_TX = "0x9147d74ef5749b7f27eb2e2528e5a611060b3f609b435f7f50ac87f49e5b957c";

/** Pressed until it takes: a press that lands before React has hydrated the page does nothing. */
async function loadThePreset(page: Page): Promise<void> {
  const preset = page.getByRole("button", {name: "Load The 1155 WBTC loss, May 2024"});
  await expect(async () => {
    await preset.click();
    await expect(
      page.getByText(/Reading transfers|Checking who signed|Asking again|signers resolved/).first(),
    ).toBeVisible({timeout: 2_000});
  }).toPass({timeout: 30_000});
}

const attacker = (page: Page) => page.locator("li").filter({hasText: ATTACKER});

/** How far the page runs past the side of the screen; anything above zero scrolls sideways. */
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const screen of [
  {name: "a laptop", width: 1280, height: 800},
  {name: "a phone", width: 375, height: 812},
  {name: "a small phone", width: 320, height: 640},
]) {
  test(`on ${screen.name}, the preset shows fourteen to avoid and the attacker's verdict in full`, async ({page}) => {
    await page.setViewportSize({width: screen.width, height: screen.height});
    await replayMainnet(page);
    await page.goto("./");
    await loadThePreset(page);

    const main = page.locator("main");
    await expect(main).toContainText("231 transfers · 15 counterparties");
    await expect(main).toContainText("14 to avoid");
    await expect(main).toContainText("1 counterfeit token in this history");
    await expect(main).not.toContainText("could not be checked");

    const verdict = attacker(page).getByText("Do not send");
    await expect(verdict).toBeVisible();
    await expect(attacker(page)).toContainText("65");

    const box = await verdict.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(screen.width);
    expect(await overflow(page)).toBe(0);
  });
}

/**
 * The silent failure this project used to have: one refused lookup, the bait's, and the attacker
 * read "Looks fine" with nothing on the screen to say a record was missing.
 */
test("when the endpoint refuses the bait's lookup, the scan says it is incomplete, and the attacker is never fine", async ({page}) => {
  await replayMainnet(page, {transactions: [BAIT_TX]});
  await page.goto("./");
  await loadThePreset(page);

  const main = page.locator("main");
  await expect(main).toContainText("This scan is incomplete.", {timeout: 20_000});
  await expect(main).toContainText("1 could not be checked");
  await expect(main).toContainText("13 to avoid");
  await expect(attacker(page)).toContainText("Worth a look");
  await expect(attacker(page)).not.toContainText("Looks fine");
});

test("the verdict follows the user from Scan to Send", async ({page}) => {
  await replayMainnet(page);
  await page.goto("./");
  await loadThePreset(page);
  await expect(page.locator("main")).toContainText("14 to avoid");

  await page.getByRole("link", {name: "Send", exact: true}).click();
  await page.getByPlaceholder("0x…", {exact: true}).fill("0xd9a1c3788d81257612e2581a6ea0ada244853a91");

  const panel = page.locator("aside");
  await expect(panel).toContainText("Checked against your scan of");
  await expect(panel).toContainText("Do not send");
});
