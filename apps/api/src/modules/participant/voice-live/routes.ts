import type { App } from "../../../app.js";
import { guard } from "../../../auth/access.js";
import type { RouteContext } from "../../../context.js";
import { CLOSE_POLICY } from "./protocol.js";
import { LiveVoiceSession } from "./session.js";

/**
 * The real-time voice cascade (FR-30a): streaming speech in, the engine, streaming speech out.
 *
 * The engine stays the brain. Nothing here decides what to ask; it turns audio into an answer,
 * hands that answer to exactly the same turn the text interview runs, and speaks the result. Every
 * exchange is still an ordinary `Message` row, so a session can be started by voice, continued by
 * typing, and analyzed without anything downstream knowing the difference.
 *
 * **Why a WebSocket, and why it is reached directly.** Every other browser call goes through the
 * Next.js proxy, which keeps the API off the internet. Next.js route handlers cannot upgrade a
 * connection, so live voice is the one path Caddy sends to the API itself. It is authenticated by
 * the same `aidp_participant` cookie the proxy sets — same site, so the browser attaches it — and
 * the socket can do nothing a participant could not already do over HTTP.
 *
 * **Two ways to hear, announced in `ready.mode`.** With an `stt_stream` route (D-77) the browser
 * streams PCM16 at 24 kHz continuously; this pipes it to the provider's realtime transcription
 * socket, forwards the growing text as `caption_partial` while the participant is still talking,
 * and on the provider's final transcript takes the turn. Without one, or when that socket cannot
 * be opened, the call runs in `utterance` mode: the browser detects the end of speech itself and
 * sends each utterance as one recording for the `transcription` route (D-70). A streaming session
 * that dies mid-call drops to `utterance` mode with a `mode` frame, when there is a transcription
 * route to drop to; otherwise the participant is pointed at typing.
 *
 * Layout of this directory: `protocol.ts` (frames, ceilings), `state.ts` and `audio-gate.ts` and
 * `metrics.ts` (what a call remembers), `hearing.ts` (streaming transcription), `turn.ts` (one
 * exchange), `speech.ts` (the voice), `degrade.ts` (the fallback chain), `session.ts` (the socket
 * and the wiring).
 */
export async function participantVoiceLiveRoutes(app: App, ctx: RouteContext): Promise<void> {
  app.get(
    "/p/session/live",
    // No HEAD twin: Fastify would register one that runs this handler without a socket, and answer
    // 500. A plain request to this path is a 404; only an upgrade reaches the handler.
    { ...guard.participantSocket(), websocket: true, exposeHeadRoute: false, schema: { hide: true } },
    (socket, req) => {
      // The principal comes from the auth plugin's onRequest hook, exactly as on every HTTP route;
      // an upgraded request goes through the same lifecycle. The check is inline rather than a
      // guard hook because a refused socket has to be closed with a status code, and a thrown
      // AppError would try to write a JSON body to a connection the browser is expecting to
      // upgrade. The principal is anonymous for a deleted session and for a suspended tenant too.
      // A browser always names the page that opened the socket. The participant cookie is
      // SameSite=Lax, so any page on a sibling subdomain of the same site would carry it here and
      // could speak as the participant: only this application's own pages may open a call.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== ctx.config.WEB_ORIGIN) {
        socket.close(CLOSE_POLICY, "origin not allowed");
        return;
      }
      const principal = req.principal;
      if (principal.kind !== "participant") {
        socket.close(CLOSE_POLICY, "participant session required");
        return;
      }
      void new LiveVoiceSession(ctx, socket, {
        companyId: principal.companyId,
        sessionId: principal.sessionId,
      }).run();
    },
  );
}
