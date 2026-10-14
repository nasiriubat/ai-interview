import {
  InterviewEngine,
  LexicalRecall,
  type EngineSettings,
  type Logger,
  type RequirementsSettings,
} from "@aidp/ai";
import type { PrismaClient } from "@prisma/client";
import { AttachmentRecall, CombinedRecall } from "../attachments/recall.js";
import type { CallerFactory } from "../providers/caller-factory.js";
import type { SettingsService, SettingScopeRef } from "../settings/service.js";
import { PrismaSessionStore } from "./prisma-store.js";
import { PrismaPromptSource } from "./prompt-source.js";

export interface EngineBundle {
  engine: InterviewEngine;
  store: PrismaSessionStore;
  settings: EngineSettings;
}

/** Wires the engine for one session: tenant caller, Prisma store, prompts, recall, effective settings. */
export class EngineFactory {
  constructor(
    private readonly db: PrismaClient,
    private readonly callers: CallerFactory,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  /**
   * @param sessionId when given, the engine can also recall passages from that session's
   * attachments (FR-31). Omitted by callers that build an engine without a session in hand; recall
   * then covers the transcript only, exactly as before.
   */
  async forSession(companyId: string, chain: SettingScopeRef[], sessionId?: string): Promise<EngineBundle> {
    const values = await this.settings.resolveMany(
      [
        "engine.recentWindowTurns",
        "engine.inputTokenBudget",
        "engine.summarizeEveryTurns",
        "engine.extractEveryTurns",
        "engine.maxTurns",
        "requirements.aggressivenessTechnical",
        "requirements.aggressivenessNontechnical",
        "requirements.mvpChallenge",
        "features.optionsView",
      ],
      chain,
    );
    const settings: EngineSettings = {
      recentWindowTurns: values["engine.recentWindowTurns"] as number,
      inputTokenBudget: values["engine.inputTokenBudget"] as number,
      summarizeEveryTurns: values["engine.summarizeEveryTurns"] as number,
      extractEveryTurns: values["engine.extractEveryTurns"] as number,
      maxTurns: values["engine.maxTurns"] as number,
      requirements: {
        aggressivenessTechnical: values[
          "requirements.aggressivenessTechnical"
        ] as RequirementsSettings["aggressivenessTechnical"],
        aggressivenessNontechnical: values[
          "requirements.aggressivenessNontechnical"
        ] as RequirementsSettings["aggressivenessNontechnical"],
        mvpChallenge: values["requirements.mvpChallenge"] as RequirementsSettings["mvpChallenge"],
      },
    };
    const store = new PrismaSessionStore(this.db, {
      widgets: values["features.optionsView"] !== false,
    });
    const caller = await this.callers.forCompany(companyId);
    // One recall source over two corpora: the participant's own earlier words, and whatever they
    // attached. The engine asks for passages relevant to the current topic and does not need to
    // know that files exist.
    const messageRecall = new LexicalRecall(store, settings.recentWindowTurns);
    const recall = sessionId
      ? new CombinedRecall(
          messageRecall,
          new AttachmentRecall({ db: this.db, caller, logger: this.logger }),
          { companyId, sessionId },
        )
      : messageRecall;
    const engine = new InterviewEngine({
      caller,
      store,
      prompts: new PrismaPromptSource(this.db),
      recall,
      logger: this.logger,
    });
    return { engine, store, settings };
  }
}
