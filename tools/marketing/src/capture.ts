/**
 * Photographs a running stack for marketing material (D-469). It signs in as a tenant admin
 * through the emailed link (read from Mailpit's API), finds the campaign and the requirements
 * interview to show, and writes numbered PNGs plus index.md. See tools/marketing/README.md.
 *
 *   ADMIN_EMAIL=laura@example.org BASE=http://localhost:3000 MAILPIT=http://localhost:8025 \
 *     pnpm --filter @aidp/marketing capture
 *
 * It never reads or prints a provider key. With INTERVIEW=1 it takes two short real interviews
 * through the share link (a handful of model calls on whatever routes the stack has).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  codeIn,
  configFrom,
  fileName,
  indexMarkdown,
  linkIn,
  selected,
  SHOTS,
  type CaptureConfig,
  type Shot,
} from "./plan.js";

const cfg: CaptureConfig = configFrom(process.env);
const OUT = path.resolve(cfg.out);
mkdirSync(OUT, { recursive: true });
const taken = new Set<string>();
const skipped: string[] = [];
const host = new URL(cfg.base).hostname;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface MailRow {
  ID: string;
  Created: string;
}

/** The newest message to an address that arrived after `since`, polling Mailpit's API. */
async function mailTo(to: string, since: number): Promise<string> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${cfg.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}&limit=5`);
    const rows = ((await res.json()) as { messages?: MailRow[] }).messages ?? [];
    const hit = rows.find((m) => new Date(m.Created).getTime() >= since);
    if (hit) {
      const msg = (await (await fetch(`${cfg.mailpit}/api/v1/message/${hit.ID}`)).json()) as {
        Text?: string;
        HTML?: string;
      };
      return `${msg.Text ?? ""}\n${msg.HTML ?? ""}`;
    }
    await sleep(1000);
  }
  throw new Error(`no mail to ${to} arrived in Mailpit within 45 s`);
}

async function newContext(
  browser: Browser,
  shot: Pick<Shot, "viewport" | "locale" | "theme">,
  state?: string,
): Promise<BrowserContext> {
  const phone = shot.viewport === "phone";
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: shot.theme,
    locale: shot.locale === "fi" ? "fi-FI" : "en-GB",
    permissions: ["microphone"],
    ...(state ? { storageState: state } : {}),
  });
  await ctx.addCookies([
    { name: "lang", value: shot.locale, domain: host, path: "/" },
    { name: "theme", value: shot.theme, domain: host, path: "/" },
  ]);
  return ctx;
}

/** Waits for the page to settle: network idle, fonts, no skeletons, no spinners. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  for (let i = 0; i < 20; i++) {
    const busy = await page
      .locator('[data-slot="skeleton"], [aria-busy="true"], .animate-pulse')
      .count()
      .catch(() => 0);
    if (busy === 0) break;
    await sleep(500);
  }
  await sleep(600);
}

async function save(page: Page, shot: Shot, opts: { fullPage?: boolean } = {}): Promise<void> {
  await settle(page);
  const file = path.join(OUT, fileName(shot));
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  taken.add(fileName(shot));
  console.log(`saved ${fileName(shot)}`);
}

async function signIn(browser: Browser): Promise<string> {
  const ctx = await newContext(browser, { viewport: "desktop", locale: "en", theme: "light" });
  const page = await ctx.newPage();
  await page.goto(`${cfg.base}/auth/signin`);
  const since = Date.now() - 2000;
  await page.locator('input[type="email"]').fill(cfg.adminEmail);
  await page.locator('button[type="submit"]').click();
  const link = linkIn(await mailTo(cfg.adminEmail, since), "/api/auth/callback");
  if (!link) throw new Error("the sign-in mail carried no callback link");
  await page.goto(link);
  await page.waitForURL(/\/admin/);
  const state = path.join(mkdtempSync(path.join(tmpdir(), "aidp-capture-")), "state.json");
  await ctx.storageState({ path: state });
  await ctx.close();
  return state;
}

/** The first detail link on a list page, e.g. the newest campaign. */
async function firstId(browser: Browser, state: string, list: string, pattern: RegExp): Promise<string> {
  const ctx = await newContext(browser, { viewport: "desktop", locale: "en", theme: "light" }, state);
  const page = await ctx.newPage();
  await page.goto(`${cfg.base}${list}`);
  await settle(page);
  const hrefs = await page
    .locator("main a[href]")
    .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  await ctx.close();
  const id = hrefs.map((h) => pattern.exec(h)?.[1]).find(Boolean);
  if (!id) throw new Error(`nothing to photograph at ${list}`);
  return id;
}

interface Ids {
  campaign: string;
  requirements: string;
  /** The newest finished specification version of that interview, as its number. */
  version: string;
  share: string;
}

type Step = (page: Page, ids: Ids) => Promise<void>;

/** What each staff shot does before the picture is taken. */
const STAFF: Record<string, Step> = {
  "admin-overview": async (p) => {
    await p.goto(`${cfg.base}/admin`);
  },
  campaign: async (p, ids) => {
    await p.goto(`${cfg.base}/admin/campaigns/${ids.campaign}`);
  },
  "results-overview": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/campaigns/${ids.campaign}/results`);
  },
  "fi-results-overview": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/campaigns/${ids.campaign}/results`);
  },
  "dark-results-overview": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/campaigns/${ids.campaign}/results`);
  },
  "results-opportunities": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/campaigns/${ids.campaign}/results?tab=opportunities`);
  },
  "opportunity-detail": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/campaigns/${ids.campaign}/results?tab=opportunities`);
    await settle(p);
    // Opens the first opportunity's detail panel from its row.
    await p
      .getByRole("button", { name: /^Open details:/ })
      .first()
      .click();
    await p
      .getByRole("dialog")
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => undefined);
  },
  "results-departments": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/campaigns/${ids.campaign}/results?tab=departments`);
  },
  report: async (p, ids) => {
    await p.goto(`${cfg.base}/admin/campaigns/${ids.campaign}/report`);
  },
  "requirements-workspace": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/requirements/${ids.requirements}`);
    await settle(p);
    // The live draft beside the conversation, at the numbered requirements.
    await p.getByRole("heading", { name: "Functional requirements" }).first().scrollIntoViewIfNeeded();
  },
  "requirements-readback": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/requirements/${ids.requirements}`);
    await settle(p);
    // The read-back is the interviewer's longest message near the end; scroll it into view.
    const items = p.getByRole("region", { name: "Conversation" }).getByRole("listitem");
    const n = await items.count();
    let best = -1;
    let length = 0;
    for (let i = Math.max(0, n - 8); i < n; i++) {
      const text = await items.nth(i).innerText();
      if (/^Interviewer/i.test(text) && text.length > length) {
        best = i;
        length = text.length;
      }
    }
    if (best >= 0) await items.nth(best).scrollIntoViewIfNeeded();
  },
  "spec-document": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/requirements/${ids.requirements}/versions/${ids.version}`);
    await settle(p);
    await p.getByRole("region", { name: "Specification" }).scrollIntoViewIfNeeded();
    await p.mouse.wheel(0, 700);
  },
  "spec-compare": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/requirements/${ids.requirements}/versions/${ids.version}`);
    await settle(p);
    // Compare with the previous version.
    await p.getByRole("button", { name: "Compare with" }).click();
    // The first option is "no comparison"; the versions follow, newest first.
    await p.getByRole("option", { name: /^v\d/ }).first().click();
    await settle(p);
    await p.getByRole("region", { name: "Compare with" }).scrollIntoViewIfNeeded();
    await p.mouse.wheel(0, 300);
  },
  "spec-diagram": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/requirements/${ids.requirements}`);
    await settle(p);
    // Full screen shows the whole diagram; in the panel a wide one scrolls sideways.
    await p.getByRole("button", { name: "Open full screen" }).first().click();
    await p.getByRole("dialog").waitFor();
  },
  "spec-export": async (p, ids) => {
    await p.goto(`${cfg.base}/admin/requirements/${ids.requirements}/versions/${ids.version}`);
    await settle(p);
    await p.getByRole("button", { name: "Downloads" }).click();
    await p.getByRole("menuitem").first().waitFor();
  },
  "settings-branding": async (p) => {
    await p.goto(`${cfg.base}/admin/settings?category=branding`);
  },
  account: async (p) => {
    await p.goto(`${cfg.base}/admin/account`);
  },
};

/** Public pages: no sign-in. */
const PUBLIC: Record<string, Step> = {
  "landing-hero": async (p) => {
    await p.goto(`${cfg.base}/`);
  },
  "fi-landing-hero": async (p) => {
    await p.goto(`${cfg.base}/`);
  },
  "landing-chatbot": async (p) => {
    await p.goto(`${cfg.base}/#chatbot`);
    await settle(p);
    await p.locator("#chatbot").scrollIntoViewIfNeeded();
  },
  "landing-trust": async (p) => {
    await p.goto(`${cfg.base}/#trust`);
    await settle(p);
    await p.locator("#trust").scrollIntoViewIfNeeded();
  },
  "participant-arrival": async (p, ids) => {
    await p.goto(ids.share);
  },
  "participant-arrival-phone": async (p, ids) => {
    await p.goto(ids.share);
  },
  "fi-participant-arrival": async (p, ids) => {
    await p.goto(ids.share);
  },
};

/** The newest specification version listed for a requirements interview. */
async function latestVersion(browser: Browser, state: string, requirements: string): Promise<string> {
  const ctx = await newContext(browser, { viewport: "desktop", locale: "en", theme: "light" }, state);
  const page = await ctx.newPage();
  await page.goto(`${cfg.base}/admin/requirements/${requirements}`);
  await settle(page);
  await page.getByRole("tab", { name: /Specification documents/ }).click();
  await settle(page);
  const hrefs = await page
    .locator("main a[href*='/versions/']")
    .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  await ctx.close();
  const numbers = hrefs.map((h) => Number(/\/versions\/(\d+)/.exec(h)?.[1] ?? 0)).filter((n) => n > 0);
  if (numbers.length === 0)
    throw new Error("the requirements interview has no finished specification version");
  return String(Math.max(...numbers));
}

/** The share link shown on the campaign page. */
async function shareLink(browser: Browser, state: string, campaign: string): Promise<string> {
  const ctx = await newContext(browser, { viewport: "desktop", locale: "en", theme: "light" }, state);
  const page = await ctx.newPage();
  await page.goto(`${cfg.base}/admin/campaigns/${campaign}`);
  await settle(page);
  const values = await page
    .locator("input")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  await ctx.close();
  const link = values.find((v) => v.includes("/p/"));
  if (!link) throw new Error("the campaign page shows no share link; is the campaign open?");
  return link;
}

/** The report PDF's first page, rasterised by whatever the machine has (pdftoppm, or sips on macOS). */
async function reportPdf(browser: Browser, state: string, ids: Ids, shot: Shot): Promise<void> {
  const ctx = await newContext(browser, shot, state);
  const page = await ctx.newPage();
  await page.goto(`${cfg.base}/admin/campaigns/${ids.campaign}/report`);
  await settle(page);
  await page.getByRole("button", { name: /^Export/ }).click();
  // "PDF" (composed on the server), not "Print or save as PDF".
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.getByRole("menuitem", { name: /^PDF/ }).click(),
  ]);
  const pdf = path.join(mkdtempSync(path.join(tmpdir(), "aidp-pdf-")), "report.pdf");
  await download.saveAs(pdf);
  await ctx.close();
  const out = path.join(OUT, fileName(shot));
  try {
    execFileSync("pdftoppm", [
      "-png",
      "-r",
      "110",
      "-singlefile",
      "-f",
      "1",
      "-l",
      "1",
      pdf,
      out.replace(/\.png$/, ""),
    ]);
  } catch {
    try {
      execFileSync("sips", ["-s", "format", "png", "-Z", "1800", pdf, "--out", out], { stdio: "ignore" });
    } catch {
      skipped.push(`${fileName(shot)}: no PDF rasteriser (install poppler's pdftoppm); the PDF is at ${pdf}`);
      return;
    }
  }
  if (existsSync(out)) {
    taken.add(fileName(shot));
    console.log(`saved ${fileName(shot)}`);
  }
}

const ANSWERS = [
  "I work at the front desk of one of our clinics. Mostly bookings, phone calls and the referral letters that come in.",
  "Bookings arrive by phone, the web form and at the desk, and I type the web ones into the booking system by hand, about forty a day.",
  "Referral letters still come by fax and post. I scan them, rename the file and attach it to the patient record, which takes most of my afternoon.",
];

/** A short real interview through the share link, for the chat, voice and summary shots. */
async function interview(browser: Browser, ids: Ids, viewport: "desktop" | "phone"): Promise<void> {
  const chat = SHOTS.find(
    (x) => x.name === (viewport === "phone" ? "participant-chat-phone" : "participant-chat"),
  )!;
  const voice = SHOTS.find((x) => x.name === "participant-voice-phone")!;
  const end = SHOTS.find(
    (x) => x.name === (viewport === "phone" ? "participant-summary-phone" : "participant-summary"),
  )!;
  const mine = viewport === "phone" ? [chat, voice, end] : [chat, end];
  if (!mine.some((x) => selected(x, cfg.only))) return;
  const b =
    viewport === "phone" && cfg.micWav
      ? await chromium.launch({
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-audio-capture=${cfg.micWav}`,
          ],
        })
      : browser;
  const ctx = await newContext(b, chat);
  const page = await ctx.newPage();
  const email = `demo.${viewport}.${Date.now().toString(36)}@example.org`;
  await page.goto(ids.share);
  await settle(page);
  await page.getByRole("button", { name: /^Continue$/ }).click();
  const box = page.getByRole("textbox", { name: /^Email$/ });
  if (await box.isVisible({ timeout: 3000 }).catch(() => false)) {
    const since = Date.now() - 2000;
    await box.fill(email);
    await page.getByRole("button", { name: /Send code/ }).click();
    const code = codeIn(await mailTo(email, since));
    if (!code) throw new Error("no code in the verification mail");
    await page.getByRole("textbox", { name: /Six-digit code/ }).fill(code);
    await page.getByRole("button", { name: /^Confirm$/ }).click();
  }
  await page.getByText("A few details").waitFor();
  const role = page.getByRole("textbox", { name: /^Role/ });
  if (await role.isVisible().catch(() => false)) await role.fill("Receptionist");
  const dept = page.getByRole("textbox", { name: /^Department/ });
  if (await dept.isVisible().catch(() => false)) await dept.fill("Front desk");
  const anon = page.getByRole("radio", { name: /Anonymously/ });
  if (await anon.isVisible().catch(() => false)) await anon.click();
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Start the interview/ }).click();
  const composer = page.getByRole("textbox", { name: "Your answer" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  const waitForQuestion = async (): Promise<void> => {
    await composer.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[aria-live="off"]').length === 0, null, {
      timeout: 120_000,
    });
    await sleep(1500);
  };
  for (const answer of ANSWERS.slice(0, viewport === "phone" ? 2 : 3)) {
    await waitForQuestion();
    await composer.fill(answer);
    await send.click();
  }
  await waitForQuestion();
  if (selected(chat, cfg.only)) await save(page, chat);
  if (viewport === "phone" && cfg.micWav && selected(voice, cfg.only)) {
    await page.getByRole("button", { name: "Record your answer" }).click();
    await sleep(Number(process.env.MIC_SECONDS ?? 12) * 1000);
    await page.getByRole("button", { name: "Stop and send the recording" }).click();
    await waitForQuestion();
    await sleep(4000);
    await save(page, voice);
  }
  await page.getByRole("button", { name: "Interview options" }).click();
  await page.getByRole("button", { name: "I'm done" }).click();
  await page.getByRole("button", { name: /^Finish$/ }).click();
  // One closing question, then the summary.
  await waitForQuestion();
  if (await composer.isVisible().catch(() => false)) {
    await composer.fill("No, I think that covers it. Thank you.");
    await send.click();
  }
  await page.getByText(/What happens next/).waitFor({ timeout: 180_000 });
  if (selected(end, cfg.only)) await save(page, end);
  await ctx.close();
  if (b !== browser) await b.close();
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const state = await signIn(browser);
  const campaign =
    cfg.campaignId ||
    (await firstId(browser, state, "/admin/campaigns", /\/admin\/campaigns\/([a-z0-9]{10,})$/));
  const requirements =
    cfg.requirementsId ||
    (await firstId(browser, state, "/admin/requirements", /\/admin\/requirements\/([a-z0-9]{10,})$/));
  const ids: Ids = {
    campaign,
    requirements,
    version: await latestVersion(browser, state, requirements),
    share: await shareLink(browser, state, campaign),
  };

  for (const shot of SHOTS) {
    if (!selected(shot, cfg.only)) continue;
    if (shot.name === "report-pdf") {
      await reportPdf(browser, state, ids, shot).catch((e: unknown) =>
        skipped.push(`${fileName(shot)}: ${String(e)}`),
      );
      continue;
    }
    const step = STAFF[shot.name] ?? PUBLIC[shot.name];
    if (!step) continue; // the interview shots are taken below
    const ctx = await newContext(browser, shot, STAFF[shot.name] ? state : undefined);
    const page = await ctx.newPage();
    try {
      await step(page, ids);
      await save(page, shot);
    } catch (e) {
      skipped.push(`${fileName(shot)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await ctx.close();
  }

  if (cfg.interview) {
    for (const v of ["desktop", "phone"] as const)
      await interview(browser, ids, v).catch((e: unknown) => skipped.push(`interview (${v}): ${String(e)}`));
  } else {
    skipped.push(
      "participant chat, voice and summary: set INTERVIEW=1 to take a short real interview for them",
    );
  }
  await browser.close();

  // A partial retake (ONLY=...) keeps the earlier pictures in the index.
  const listed = new Set([...taken, ...SHOTS.map(fileName).filter((f) => existsSync(path.join(OUT, f)))]);
  writeFileSync(
    path.join(OUT, "index.md"),
    indexMarkdown(
      SHOTS,
      listed,
      "Captured from a running stack by `tools/marketing/capture.ts`. The people, the company and the numbers are from a simulated demo.",
    ),
  );
  console.log(`\n${taken.size} screenshots in ${OUT}`);
  if (skipped.length) console.log(`not taken:\n- ${skipped.join("\n- ")}`);
}

await main();
