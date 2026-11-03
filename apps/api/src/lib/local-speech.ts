import { localWhisperModel, type SpeechService } from "@aidp/ai";
import { withSystemTenant } from "@aidp/db";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

/**
 * Which on-server Whisper model to load at boot, if any (D-75).
 *
 * The platform's `transcription` route wins when it points at a `local` provider, because that is
 * what every tenant without an override uses. Otherwise the model most tenant routes name. Only
 * one model is kept in memory, so there is exactly one answer or none.
 */
export async function localSpeechModelToWarm(db: PrismaClient): Promise<string | undefined> {
  // Tenant routes are behind row-level security; this reads across all of them to count models,
  // and returns nothing but a model id.
  const routes = await withSystemTenant(() =>
    db.route.findMany({
      where: { purpose: "transcription", provider: { kind: "local", enabled: true } },
      select: { companyId: true, model: true },
    }),
  );
  const known = routes.filter((r) => localWhisperModel(r.model));
  const platform = known.find((r) => r.companyId === null);
  if (platform) return platform.model;
  const counts = new Map<string, number>();
  for (const r of known) counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * Starts loading the model in the background so the first participant to record does not wait
 * for a 250 MB download. Never throws and never delays startup: an offline server boots, logs why,
 * and the first transcription tries again.
 */
export async function warmLocalSpeech(db: PrismaClient, log: Logger, runner: SpeechService): Promise<void> {
  let model: string | undefined;
  try {
    model = await localSpeechModelToWarm(db);
  } catch (err) {
    log.warn({ err }, "local speech: could not read the transcription routes; not warming up");
    return;
  }
  if (!model) return;
  const started = Date.now();
  log.info({ model }, "local speech: loading the Whisper model");
  let lastLogged = -1;
  await runner.warmUp(model, (fraction) => {
    if (fraction === undefined) return;
    const tenth = Math.floor(fraction * 10);
    if (tenth === lastLogged) return;
    lastLogged = tenth;
    log.info({ model, progress: Math.round(fraction * 100) }, "local speech: downloading");
  });
  const status = runner.status();
  if (status.state === "ready") {
    log.info({ model, ms: Date.now() - started }, "local speech: ready");
  } else {
    log.warn(
      { model, state: status.state, error: status.error },
      "local speech: model did not load; recorded answers will retry it",
    );
  }
}
