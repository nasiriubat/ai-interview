#!/usr/bin/env node
// The live voice path, end to end, through Caddy: a participant session, then the WebSocket at
// /api/v1/p/session/live (the one path Caddy sends to the API directly), a scripted audio frame, and
// the interviewer's spoken reply.
//
//   deploy/drill/stack.sh run node deploy/drill/voice.mjs [turns]
//
// The fake provider's realtime socket declares an utterance finished after it has been sent
// FAKE_STT_UTTERANCE_MS of audio, so this sends that much PCM16 at 24 kHz in 100 ms frames, at
// real-time pace, as a browser would.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, Client, log, sleep } from "./lib.mjs";

const dir = process.env.AIDP_DRILL_DIR;
const campaign = JSON.parse(readFileSync(join(dir, "campaign.json"), "utf8"));
const turns = Number(process.argv[2] ?? 2);

const p = new Client("voice-participant");
const arrival = await p.ok("GET", `/api/participant/p/${campaign.linkToken}`);
await p.ok("POST", `/api/participant/p/${campaign.linkToken}/open`, {});
await p.ok("POST", "/api/participant/p/session/consent", {
  consentVersion: arrival.campaign.consentVersion ?? "v1",
  participantFields: { name: "Voice drill" },
  participationChoice: "anonymous",
});
await p.ok("POST", "/api/participant/p/session/mode", { mode: "voice" });

const url = `${BASE.replace(/^http/, "ws")}/api/v1/p/session/live`;
const ws = new WebSocket(url, { headers: { cookie: p.cookieHeader() } });
ws.binaryType = "arraybuffer";

const frames = [];
let binaryBytes = 0;
const t0 = Date.now();
ws.addEventListener("message", (e) => {
  if (typeof e.data === "string") {
    const f = JSON.parse(e.data);
    frames.push({ at: Date.now() - t0, ...f });
  } else {
    binaryBytes += e.data.byteLength;
    frames.push({ at: Date.now() - t0, type: "audio", bytes: e.data.byteLength });
  }
});
const closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("the voice socket did not open")), { once: true });
});
log("socket open through Caddy");

const until = async (what, check, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; frames: ${JSON.stringify(frames.map((f) => f.type))}`);
    await sleep(25);
  }
};
const count = (type) => frames.filter((f) => f.type === type).length;

await until("ready", () => count("ready") > 0);
const ready = frames.find((f) => f.type === "ready");
log(`ready: mode=${ready.mode} sampleRate=${ready.sampleRate ?? "-"}`);

ws.send(JSON.stringify({ type: "start" }));
await until("the first question spoken", () => count("audio") > 0 && count("turn") > 0);
const firstWordMs = frames.find((f) => f.type === "audio").at;
log(`first question: first audio ${firstWordMs} ms after the socket opened, ${count("turn")} turn frame(s)`);

const results = [];
for (let i = 0; i < turns; i++) {
  await until("the question to finish", () => count("speech_end") > i || count("audio") > 0, 20_000);
  await sleep(300);
  const before = { audio: count("audio"), turn: count("turn") };
  const sentAt = Date.now();
  // 1.2 s of a quiet tone, in 100 ms frames of PCM16 mono at 24 kHz, at real-time pace.
  for (let f = 0; f < 12; f++) {
    const pcm = Buffer.alloc(4800);
    for (let s = 0; s < 2400; s++) pcm.writeInt16LE(Math.round(Math.sin((s / 24) * Math.PI) * 800), s * 2);
    if (ready.mode === "stream") ws.send(pcm);
    else ws.send(pcm);
    await sleep(100);
  }
  if (ready.mode !== "stream") ws.send(JSON.stringify({ type: "utterance", durationMs: 1200 }));
  await until("the answer to be heard and a turn taken", () => count("turn") > before.turn, 30_000);
  await until("the reply to be spoken", () => count("audio") > before.audio, 30_000);
  const reply = frames.slice().reverse().find((f) => f.type === "audio");
  results.push({
    turn: i + 1,
    caption: frames.filter((f) => f.type === "caption_final" || f.type === "caption").length,
    answerToFirstAudioMs: frames.find((f, idx) => f.type === "audio" && idx > frames.findIndex((x) => x.type === "turn" && x.at >= sentAt - t0))?.at - (sentAt - t0),
    replyAt: reply.at,
  });
}
ws.send(JSON.stringify({ type: "bye" }));
const code = await Promise.race([closed, sleep(5000).then(() => "timeout")]);
console.log(
  JSON.stringify({
    ok: true,
    mode: ready.mode,
    firstWordMs,
    exchanges: results,
    frameTypes: [...new Set(frames.map((f) => f.type))],
    audioBytes: binaryBytes,
    closeCode: code,
  }),
);
process.exit(0);
