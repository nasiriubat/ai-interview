import { generateRecap, recapIsCurrent, type ModelCallerPort } from "@aidp/ai";
import {
  PrismaPromptSource,
  PrismaSessionStore,
  switchEnabled,
  toStored,
  type AttachmentService,
  type AttachmentView,
  type SettingsService,
} from "@aidp/core";
import { SessionStateSchema } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import type { ParticipantService } from "./service.js";

export interface ParticipantSessionPayload {
  session: ReturnType<ParticipantService["sessionView"]> & {
    progress: { areas: { key: string; name: string; status: string }[] };
    messages: ReturnType<typeof toStored>[];
    attachments: AttachmentView[];
    /**
     * Two sentences on where the participant left off, for a banner above the conversation
     * (spec 06). Never a message: it is not in `messages`, the transcript or the model's context.
     * Present only when the interview has begun and the participant has been away.
     */
    recap?: { text: string; source: "model" | "fallback" };
    capabilities: {
      recordedVoice: boolean;
      liveVoice: boolean;
      captions: boolean;
      fileUpload: boolean;
      optionsView: boolean;
      maxSizeMb: number;
      allowedTypes: string[];
    };
  };
}

/**
 * What a participant's own screen needs to render the interview: the session, its progress by
 * coverage area, the transcript so far, files, and what the browser may do (`capabilities`).
 * Read side only; the participant's writes are `ParticipantService`.
 */
export class ParticipantSessionReader {
  constructor(
    private readonly db: PrismaClient,
    private readonly settings: SettingsService,
    private readonly attachments: AttachmentService,
    private readonly participant: Pick<ParticipantService, "sessionView">,
    /** The tenant's model caller, for the recap. Absent in tools that only read. */
    private readonly caller?: (companyId: string) => Promise<ModelCallerPort>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async view(companyId: string, sessionId: string): Promise<ParticipantSessionPayload> {
    const session = await this.db.session.findFirstOrThrow({
      where: { id: sessionId, companyId },
      include: { participant: true, template: true },
    });
    const messages =
      session.status === "deleted"
        ? []
        : await this.db.message.findMany({ where: { sessionId: session.id }, orderBy: { seq: "asc" } });
    const state = session.state as { coverage?: Record<string, { status: string }> };
    const areas = (session.template.coverageAreas as { key: string; name: string }[]).map((a) => ({
      key: a.key,
      name: a.name,
      status: state.coverage?.[a.key]?.status ?? "untouched",
    }));
    // What the browser is allowed to do, resolved from the tenant's settings.
    //
    // Without this the client has to guess: it would offer a microphone to a tenant that turned
    // voice off and only find out from a 403 after someone had spoken, and it would pre-check
    // uploads against the shipped defaults rather than the limits actually in force, refusing a
    // file the server would have accepted. Both are worse errors than the ones they replace.
    const chain = [
      { scope: "template" as const, scopeId: session.templateId },
      { scope: "tenant" as const, scopeId: companyId },
    ];
    const values = await this.settings.resolveMany(
      [
        "features.recordedVoice",
        "features.realtimeVoice",
        "features.fileUpload",
        "features.optionsView",
        "files.maxSizeMb",
        "files.allowedTypes",
        "voice.captions",
        "engine.resumeRecap",
        "engine.recapAfterMinutes",
        "engine.maxTurns",
      ],
      chain,
    );
    // The template's `voice.enabled` is ANDed with the tenant's (D-186), so the browser hides the
    // microphone for a template that turned voice off instead of finding out from a 403.
    const voiceOn = await switchEnabled(this.settings, "voice.enabled", chain);
    const recap = await this.recap(companyId, session, messages.length, {
      enabled: values["engine.resumeRecap"] as boolean,
      afterMinutes: values["engine.recapAfterMinutes"] as number,
      maxTurns: values["engine.maxTurns"] as number,
      lastSeq: messages.at(-1)?.seq ?? 0,
    });
    const attachments =
      session.status === "deleted" ? [] : await this.attachments.list(companyId, session.id);

    return {
      session: {
        ...this.participant.sessionView(session, session.participant),
        progress: { areas },
        messages: messages.map(toStored),
        attachments,
        ...(recap ? { recap } : {}),
        capabilities: {
          recordedVoice: (values["features.recordedVoice"] as boolean) && voiceOn,
          // Live voice ships off: it costs money per second of conversation and needs both a
          // transcription and a speech route, which most tenants will not have on day one.
          liveVoice: (values["features.realtimeVoice"] as boolean) && voiceOn,
          // Off hides the "options" answer mode; the engine already sends no widgets (D-187).
          optionsView: values["features.optionsView"] as boolean,
          captions: values["voice.captions"] as boolean,
          fileUpload: values["features.fileUpload"] as boolean,
          maxSizeMb: values["files.maxSizeMb"] as number,
          allowedTypes: values["files.allowedTypes"] as string[],
        },
      },
    };
  }

  /**
   * The resume recap (D-172). Shown when the interview has begun, is not finished, and the
   * participant has been away: paused, or idle for `engine.recapAfterMinutes`. Cached in state
   * against the last message, so a refresh never calls the model again and a new turn invalidates
   * it. A model failure or an exhausted budget gives the deterministic sentence, which is cached
   * the same way. Never throws: a recap is a courtesy, and the interview must load without it.
   */
  private async recap(
    companyId: string,
    session: { id: string; status: string; state: unknown; updatedAt: Date },
    messageCount: number,
    options: { enabled: boolean; afterMinutes: number; maxTurns: number; lastSeq: number },
  ): Promise<{ text: string; source: "model" | "fallback" } | undefined> {
    if (!options.enabled || messageCount === 0) return undefined;
    if (session.status !== "paused" && session.status !== "active") return undefined;
    const idleMs = this.now().getTime() - session.updatedAt.getTime();
    if (session.status !== "paused" && idleMs < options.afterMinutes * 60_000) return undefined;
    try {
      const state = SessionStateSchema.parse(session.state);
      if (state.recap && recapIsCurrent(state, options.lastSeq))
        return { text: state.recap.text, source: state.recap.source };
      const snapshot = await new PrismaSessionStore(this.db).snapshot(session.id);
      const caller = this.caller ? await this.caller(companyId) : undefined;
      const made = await generateRecap(
        {
          caller: caller ?? NO_MODEL,
          prompts: new PrismaPromptSource(this.db),
        },
        snapshot,
        { maxTurns: options.maxTurns, useModel: caller !== undefined },
      );
      const cache = { text: made.text, source: made.source, upToSeq: options.lastSeq };
      const store = new PrismaSessionStore(this.db);
      await store.commitRecap(session.id, cache);
      // One row per recap written (a cached one is not a new visit), with how long they were away.
      await store.appendEvent(session.id, "resume", {
        source: made.source,
        idleMinutes: Math.floor(idleMs / 60_000),
      });
      return { text: made.text, source: made.source };
    } catch {
      return undefined;
    }
  }
}

/** A caller that is never asked: `generateRecap` is told not to use a model when none is wired. */
const NO_MODEL: ModelCallerPort = {
  // eslint-disable-next-line require-yield
  async *chat() {
    throw new Error("no model caller");
  },
  async complete() {
    throw new Error("no model caller");
  },
  async embed() {
    return undefined;
  },
};
