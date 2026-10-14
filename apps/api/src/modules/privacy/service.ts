import {
  buildParticipantExport,
  renderParticipantExportMarkdown,
  retentionStatus,
  type SettingsService,
} from "@aidp/core";
import type { PrismaClient } from "@prisma/client";
import { audit } from "../../lib/audit.js";
import { notFound } from "../../lib/errors.js";

/** What an admin can check about retention without reading the code (spec 11). */
export class PrivacyService {
  constructor(
    private readonly db: PrismaClient,
    private readonly settings: SettingsService,
  ) {}

  retention(companyId: string): ReturnType<typeof retentionStatus> {
    return retentionStatus({ db: this.db, settings: this.settings }, companyId);
  }

  /**
   * The participant's own copy of their data, as JSON or Markdown (D-162). Leaves an audit row
   * that records only that an export happened for a session: no content, no personal data.
   */
  async participantExport(
    companyId: string,
    sessionId: string,
    format: "json" | "md",
  ): Promise<{ body: string; contentType: string; filename: string }> {
    const data = await buildParticipantExport(this.db, { companyId, sessionId });
    if (!data) throw notFound("Interview");
    await audit(this.db, companyId, {
      actorId: null,
      action: "privacy.participant_export",
      targetType: "session",
      targetId: sessionId,
      diff: { format },
    });
    return format === "md"
      ? {
          body: renderParticipantExportMarkdown(data),
          contentType: "text/markdown; charset=utf-8",
          filename: "my-interview-data.md",
        }
      : {
          body: `${JSON.stringify(data, null, 2)}\n`,
          contentType: "application/json; charset=utf-8",
          filename: "my-interview-data.json",
        };
  }
}
