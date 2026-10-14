// Live voice sessions: the WebSocket at /api/v1/p/session/live through Caddy, a PCM16 24 kHz stream
// at real-time pace, an utterance, the interviewer's spoken reply, a few exchanges per call.
//
// `voice_first_word_ms` is the number the platform itself measures and reports in a `first_word`
// frame: the turn taken to the first audible word of the answer. `voice_reply_ms` is the same thing
// from outside, from the last audio frame sent to the first audio frame back, through Caddy.
import http from "k6/http";
import ws from "k6/ws";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { BASE, LINK, arrive } from "./lib.js";

export const voiceFirstWord = new Trend("voice_first_word_ms", true);
export const voiceReply = new Trend("voice_reply_ms", true);
export const voiceFirstPartial = new Trend("voice_first_caption_ms", true);
export const voiceSessionErrors = new Counter("voice_session_errors");
export const voiceExchanges = new Counter("voice_exchanges");

const EXCHANGES = Number(__ENV.VOICE_EXCHANGES || 4);
const UTTERANCE_MS = Number(__ENV.VOICE_UTTERANCE_MS || 1200);

/** 100 ms of a quiet tone: PCM16 mono at 24 kHz is 2400 samples, 4800 bytes. */
function frame() {
  const buf = new ArrayBuffer(4800);
  const view = new DataView(buf);
  for (let s = 0; s < 2400; s++) view.setInt16(s * 2, Math.round(Math.sin((s / 24) * Math.PI) * 800), true);
  return buf;
}

export function voiceSession() {
  if (!arrive(`k6-voice-${__VU}-${__ITER}`)) {
    voiceSessionErrors.add(1);
    return;
  }
  http.post(
    `${BASE}/api/participant/p/session/mode`,
    JSON.stringify({ mode: "voice", reason: "participant" }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
  const cookies = http.cookieJar().cookiesForURL(BASE);
  const cookie = Object.keys(cookies)
    .map((k) => `${k}=${cookies[k][0]}`)
    .join("; ");
  const url = `${BASE.replace(/^http/, "ws")}/api/v1/p/session/live`;
  let ready = false;
  let exchanges = 0;
  let sentAt = 0;
  let utteranceStart = 0;
  let partialSeen = false;
  let awaitingAudio = false;
  let streaming = true;
  const pcm = frame();

  const res = ws.connect(url, { headers: { Cookie: cookie } }, (socket) => {
    const sendUtterance = () => {
      let sent = 0;
      partialSeen = false;
      utteranceStart = Date.now();
      const frames = Math.ceil(UTTERANCE_MS / 100);
      const pump = () => {
        socket.sendBinary(pcm);
        sent++;
        if (sent < frames) socket.setTimeout(pump, 100);
        else {
          sentAt = Date.now();
          awaitingAudio = true;
          if (!streaming) socket.send(JSON.stringify({ type: "utterance", durationMs: UTTERANCE_MS }));
        }
      };
      pump();
    };
    socket.on("message", (data) => {
      let f;
      try {
        f = JSON.parse(data);
      } catch (_) {
        return;
      }
      if (f.type === "ready") {
        ready = true;
        streaming = f.mode === "stream";
        socket.send(JSON.stringify({ type: "start" }));
      } else if (f.type === "first_word") {
        voiceFirstWord.add(f.ms);
      } else if (f.type === "caption_partial" && !partialSeen && utteranceStart > 0) {
        // From the first audio frame of the answer to the first caption word: what the caption shows.
        partialSeen = true;
        voiceFirstPartial.add(Date.now() - utteranceStart);
      } else if (f.type === "unavailable" || f.type === "error") {
        voiceSessionErrors.add(1);
        socket.close();
      } else if (f.type === "speech_end") {
        // The question has been spoken; answer it, until the exchanges are used up.
        if (exchanges >= EXCHANGES) {
          socket.send(JSON.stringify({ type: "bye" }));
          socket.close();
          return;
        }
        socket.setTimeout(sendUtterance, 400);
      }
    });
    socket.on("binaryMessage", () => {
      if (awaitingAudio) {
        awaitingAudio = false;
        voiceReply.add(Date.now() - sentAt);
        exchanges++;
        voiceExchanges.add(1);
        sentAt = 0;
      }
    });
    socket.on("error", () => voiceSessionErrors.add(1));
    socket.setTimeout(() => {
      if (!ready) voiceSessionErrors.add(1);
    }, 15000);
    // A call that does not finish is a failure, not a hang.
    socket.setTimeout(() => socket.close(), 120000);
  });
  check(res, { "voice socket upgraded": (r) => r && r.status === 101 });
}
