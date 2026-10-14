import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

/*
 * The desktop frame and the messenger behaviour (D-420 to D-424). The owner took an interview on a
 * laptop: recordings stacked above the composer until the conversation was pushed out of view, the
 * page was a narrow strip in a wide empty screen, and the chat started at the top of the page.
 */

const SIZES = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

async function signIn(context: BrowserContext, info: TestInfo, token: string): Promise<void> {
  const hostname = new URL(info.project.use.baseURL ?? "http://localhost:3100").hostname;
  await context.addCookies([{ name: "aidp_participant", value: token, domain: hostname, path: "/" }]);
}

interface Geometry {
  vw: number;
  vh: number;
  pageScrollsY: boolean;
  pageScrollsX: boolean;
  lastTop: number;
  lastBottom: number;
  scrollerTop: number;
  scrollerBottom: number;
  composerBottom: number;
  footerTop: number;
  footerHeight: number;
  columnWidth: number;
  headerHeight: number;
  attachmentsHeight: number;
}

/** Where the things that must always be visible are, in page coordinates. */
async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const rect = (el: Element | null | undefined): DOMRect | undefined => el?.getBoundingClientRect();
    const items = document.querySelectorAll("ol[aria-label] > li");
    const last = rect(items[items.length - 1]);
    const scroller = rect(document.querySelector("[data-chat-scroller]"));
    const box = rect(document.querySelector("textarea"));
    const footer = rect(document.querySelector("main > footer"));
    return {
      vw,
      vh,
      pageScrollsY: document.documentElement.scrollHeight > vh + 1,
      pageScrollsX: document.documentElement.scrollWidth > vw + 1,
      lastTop: last?.top ?? -1,
      lastBottom: last?.bottom ?? -1,
      scrollerTop: scroller?.top ?? -1,
      scrollerBottom: scroller?.bottom ?? -1,
      composerBottom: box?.bottom ?? -1,
      footerTop: footer?.top ?? -1,
      footerHeight: footer?.height ?? -1,
      columnWidth: rect(document.querySelector("ol[aria-label]"))?.width ?? -1,
      headerHeight: rect(document.querySelector("body header"))?.height ?? -1,
      attachmentsHeight: rect(document.querySelector("[data-attachments]"))?.height ?? 0,
    };
  });
}

const ABOUT = /about this interview|tästä haastattelusta/i;
const JUMP = /jump to latest|siirry uusimpaan/i;

for (const size of SIZES) {
  test(`voices ${String(size.width)}x${String(size.height)}: the newest message and the composer are in view`, async ({
    page,
    context,
  }, info) => {
    await signIn(context, info, "voices");
    await page.setViewportSize(size);
    await page.goto("/p/session", { waitUntil: "networkidle" });
    await page.getByRole("textbox").first().waitFor();
    await page.waitForTimeout(500);
    const g = await geometry(page);
    expect(g.pageScrollsX, "sideways scroll").toBe(false);
    // The page is a frame: only the message list scrolls.
    expect(g.pageScrollsY, "the page itself scrolls").toBe(false);
    // The newest message ends inside the list, which ends where the composer area begins.
    expect(g.lastBottom).toBeLessThanOrEqual(g.scrollerBottom + 1);
    expect(g.lastBottom).toBeGreaterThan(g.scrollerTop);
    expect(g.footerTop).toBeGreaterThanOrEqual(g.scrollerBottom - 1);
    expect(g.composerBottom).toBeLessThanOrEqual(g.vh);
    // Eight clips cost the composer no height at all, and it has a ceiling in any case.
    expect(g.attachmentsHeight).toBe(0);
    expect(g.footerHeight).toBeLessThanOrEqual(g.vh * 0.45 + 1);
    expect(g.headerHeight).toBeLessThanOrEqual(64);
    // A reading column of a comfortable width, never the dead strip the laptop showed.
    expect(g.columnWidth).toBeLessThanOrEqual(780);
    expect(g.columnWidth).toBeGreaterThanOrEqual(Math.min(g.vw - 48, 640));
    // And the end is followed: no "Jump to latest" on arrival.
    await expect(page.getByRole("button", { name: JUMP })).toHaveCount(0);
  });
}

test("a short conversation sits directly above the composer, not at the top of the page", async ({
  page,
  context,
}, info) => {
  await signIn(context, info, "e2e-participant-token");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/p/session", { waitUntil: "networkidle" });
  await page.getByRole("textbox").first().waitFor();
  await page.waitForTimeout(400);
  const g = await geometry(page);
  // Bottom padding of the list is 24 px; anything more would be a gap.
  expect(g.scrollerBottom - g.lastBottom).toBeLessThanOrEqual(40);
});

test("recording eight answers in a row never pushes the conversation out of view", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["microphone"]);
  await signIn(context, info, "e2e-participant-token");
  let n = 0;
  await page.route("**/session/voice-turns", (route) => {
    n += 1;
    const transcript = {
      text: `Spoken answer number ${String(n)}, said out loud.`,
      attachmentId: `a${String(n)}`,
      durationMs: 3000,
    };
    const turn = {
      message: {
        id: `r${String(n)}`,
        seq: 10 + n,
        role: "assistant",
        modality: "text",
        content: `Reply number ${String(n)}. Tell me more.`,
        createdAt: "",
      },
      ended: false,
      progress: { areas: [] },
    };
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: transcript\ndata: ${JSON.stringify(transcript)}\n\nevent: turn\ndata: ${JSON.stringify(turn)}\n\n`,
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/p/session", { waitUntil: "networkidle" });
  const mic = page.getByRole("button", { name: /record your answer|nauhoita vastauksesi/i });
  for (let i = 1; i <= 8; i++) {
    await mic.click();
    await page.getByRole("timer").waitFor();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /stop and send|lopeta ja lähetä/i }).click();
    await expect(page.getByText(`Reply number ${String(i)}.`).first()).toBeVisible({ timeout: 15_000 });
  }
  const g = await geometry(page);
  expect(g.pageScrollsY).toBe(false);
  expect(g.attachmentsHeight).toBe(0);
  expect(g.lastBottom).toBeLessThanOrEqual(g.scrollerBottom + 1);
  expect(g.composerBottom).toBeLessThanOrEqual(g.vh);
  expect(g.footerHeight).toBeLessThanOrEqual(g.vh * 0.45 + 1);
  await expect(page.getByText("Spoken answer number 8, said out loud.")).toBeVisible();
});

test("scrolled up, the view stays put; the pill brings the newest message back", async ({
  page,
  context,
}, info) => {
  await signIn(context, info, "voices");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/p/session", { waitUntil: "networkidle" });
  await page.getByRole("textbox").first().waitFor();
  await page.locator("[data-chat-scroller]").evaluate((el) => {
    el.scrollTop = 0;
  });
  const pill = page.getByRole("button", { name: JUMP });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect
    .poll(async () => {
      const g = await geometry(page);
      return g.lastBottom <= g.scrollerBottom + 1 && g.lastBottom > g.scrollerTop;
    })
    .toBe(true);
});

test("wide screens show the side panel; narrower ones open it from the header", async ({
  page,
  context,
}, info) => {
  await signIn(context, info, "e2e-participant-token");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/p/session", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: ABOUT })).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByRole("heading", { name: ABOUT })).toBeHidden();
  await page.getByRole("button", { name: /interview details|haastattelun tiedot/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: ABOUT })).toBeVisible();
});
