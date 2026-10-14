/* eslint-disable -- one-off marketing demo tooling, not product code (marketing/demo-2026-10/README.md) */
/**
 * Demo part A: landing page screens and one discovery interview taken in a real browser, with the
 * employee played by the live-run simulator.
 */
import { DEMO_PERSONAS } from "../../../scripts/live-run/src/demo-personas.js";
import { simulatorSystemPrompt } from "../../../scripts/live-run/src/personas.js";
import { loadOpenRouterKey } from "../../../scripts/live-run/src/runtime.js";
import { simulateReply, type Exchange } from "../../../scripts/live-run/src/simulator.js";
import { context, launch, readJson, shot, WEB } from "./demo-lib.js";

const only = process.env.ONLY ?? "all";
const browser = await launch();
const L = "landing";
const C = "case1-discovery";

if (only === "all" || only === "landing") {
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await page.goto(WEB);
  await shot(page, L, "01-landing-hero");
  await page.locator("#chatbot").scrollIntoViewIfNeeded();
  await page.locator("#chatbot").scrollIntoViewIfNeeded();
  await page.evaluate(() => document.getElementById("chatbot")?.scrollIntoView());
  await shot(page, L, "02-landing-why-not-a-chatbot");
  await page.evaluate(() => document.getElementById("trust")?.scrollIntoView());
  await shot(page, L, "03-landing-trust");
  await page.evaluate(() => document.getElementById("paths")?.scrollIntoView());
  await shot(page, L, "04-landing-two-interviews-and-bridge");
  await ctx.close();

  const dark = await context(browser, { dark: true });
  const dp = await dark.newPage();
  await dp.goto(WEB);
  await shot(dp, L, "05-landing-hero-dark");
  await dark.close();

  const fi = await context(browser, { locale: "fi" });
  const fp = await fi.newPage();
  await fp.goto(WEB);
  await shot(fp, L, "06-landing-hero-finnish");
  await fp.evaluate(() => document.getElementById("chatbot")?.scrollIntoView());
  await shot(fp, L, "07-landing-why-not-a-chatbot-finnish");
  await fi.close();

  const mob = await context(browser, { mobile: true });
  const mp = await mob.newPage();
  await mp.goto(WEB);
  await shot(mp, L, "08-landing-hero-mobile");
  await mob.close();
}

if (only === "all" || only === "interview") {
  const { linkToken } = readJson<{ linkToken: string }>("case1.json");
  const persona = DEMO_PERSONAS.find((p) => p.id === "nur_1");
  if (!persona) throw new Error("persona");
  const sim = { apiKey: loadOpenRouterKey(), model: "qwen/qwen3-30b-a3b-instruct-2507" };
  const system = simulatorSystemPrompt(persona);
  const ctx = await context(browser);
  const page = await ctx.newPage();

  await page.goto(`${WEB}/p/${linkToken}`);
  await shot(page, C, "01-participant-arrival");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, C, "02-participant-arrival-mobile");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("With my name").click();
  await page.locator("#field-name").fill(persona.name);
  await page.locator("#field-role").fill(persona.role);
  await page.locator("#field-department").fill(persona.department);
  await shot(page, C, "03-participant-details-and-choice");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#consent-agree").click();
  await shot(page, C, "04-participant-consent");
  await page.getByRole("button", { name: "Start the interview" }).click();

  const history: Exchange[] = [];
  let turn = 0;
  let lastSeen = "";
  let widgetShot = false;
  for (; turn < 24; turn++) {
    // Wait until the interviewer's text is stable and the answer box can take input again.
    let stable = 0;
    for (let i = 0; i < 90 && stable < 3; i++) {
      await page.waitForTimeout(1000);
      const txt = (
        await page
          .locator("p[role=status]")
          .last()
          .innerText()
          .catch(() => "")
      ).trim();
      const sendEnabled = await page
        .getByRole("button", { name: "Send" })
        .isEnabled()
        .catch(() => false);
      const taReady = (await page.locator("textarea").count()) > 0;
      if (txt && txt !== lastSeen && (sendEnabled || taReady)) stable++;
      else if (txt && txt === lastSeen) stable = 0;
      else if (txt && txt !== lastSeen) stable = Math.max(stable, 1);
      const done = await page
        .getByText(/summary|Summary/)
        .first()
        .isVisible()
        .catch(() => false);
      if (done && (await page.locator("textarea").count()) === 0) break;
    }
    const assistant = (
      await page
        .locator("p[role=status]")
        .last()
        .innerText()
        .catch(() => "")
    ).trim();
    if (!assistant || assistant === lastSeen) {
      console.log(`turn ${turn}: no new assistant text, stopping`);
      break;
    }
    lastSeen = assistant;
    history.push({ role: "assistant", content: assistant });
    console.log(`turn ${turn}: Q: ${assistant.slice(0, 90)}`);
    if (turn === 0) await shot(page, C, "05-interview-first-question");
    if (turn === 6) {
      await shot(page, C, "06-interview-chat-mid-conversation");
      await page.setViewportSize({ width: 390, height: 844 });
      await shot(page, C, "07-interview-chat-mobile");
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    const radios = await page.locator("[role=radio], [role=checkbox]").count();
    if (radios > 3 && !widgetShot) {
      widgetShot = true;
      await shot(page, C, "06b-interview-answer-options");
    }
    const reply = await simulateReply(sim, system, history, "sim:browser");
    history.push({ role: "user", content: reply });
    const box = page.locator("textarea").first();
    if ((await box.count()) === 0) break;
    await box.fill(reply);
    const send = page.getByRole("button", { name: "Send" });
    if (!(await send.isVisible().catch(() => false))) break;
    await send.click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    if (/\/summary|summary/i.test(page.url())) break;
  }
  await page.waitForTimeout(4000);
  console.log("final url", page.url());
  console.log((await page.locator("main").innerText()).slice(0, 1500));
  await shot(page, C, "08-interview-end-state");
  await ctx.storageState({ path: "/private/tmp/claude-504/d/participant-state.json" });
  await ctx.close();
}
await browser.close();
