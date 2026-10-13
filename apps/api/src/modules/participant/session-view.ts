import { toStored, type AttachmentService, type AttachmentView, type SettingsService } from "@aidp/core";
import type { PrismaClient } from "@prisma/client";
import type { ParticipantService } from "./service.js";

export interface ParticipantSessionPayload {
  session: ReturnType<ParticipantService["sessionView"]> & {
    progress: { areas: { key: string; name: string; status: string }[] };
    messages: ReturnType<typeof toStored>[];
    attachments: AttachmentView[];
    capabilities: {
      recordedVoice: boolean;
      liveVoice: boolean;
      captions: boolean;
      fileUpload: boolean;
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
        "files.maxSizeMb",
        "files.allowedTypes",
        "voice.captions",
      ],
      chain,
    );
    const attachments =
      session.status === "deleted" ? [] : await this.attachments.list(companyId, session.id);

    return {
      session: {
        ...this.participant.sessionView(session, session.participant),
        progress: { areas },
        messages: messages.map(toStored),
        attachments,
        capabilities: {
          recordedVoice: values["features.recordedVoice"] as boolean,
          // Live voice ships off: it costs money per second of conversation and needs both a
          // transcription and a speech route, which most tenants will not have on day one.
          liveVoice: values["features.realtimeVoice"] as boolean,
          captions: values["voice.captions"] as boolean,
          fileUpload: values["features.fileUpload"] as boolean,
          maxSizeMb: values["files.maxSizeMb"] as number,
          allowedTypes: values["files.allowedTypes"] as string[],
        },
      },
    };
  }
}
