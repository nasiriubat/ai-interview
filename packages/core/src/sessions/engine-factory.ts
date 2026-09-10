import { InterviewEngine, LexicalRecall, type EngineSettings, type Logger } from "@aidp/ai";
import type { PrismaClient } from "@prisma/client";
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

  async forSession(companyId: string, chain: SettingScopeRef[]): Promise<EngineBundle> {
    const values = await this.settings.resolveMany(
      [
        "engine.recentWindowTurns",
        "engine.inputTokenBudget",
        "engine.summarizeEveryTurns",
        "engine.extractEveryTurns",
        "engine.maxTurns",
      ],
      chain,
    );
    const settings: EngineSettings = {
      recentWindowTurns: values["engine.recentWindowTurns"] as number,
      inputTokenBudget: values["engine.inputTokenBudget"] as number,
      summarizeEveryTurns: values["engine.summarizeEveryTurns"] as number,
      extractEveryTurns: values["engine.extractEveryTurns"] as number,
      maxTurns: values["engine.maxTurns"] as number,
    };
    const store = new PrismaSessionStore(this.db);
    const caller = await this.callers.forCompany(companyId);
    const engine = new InterviewEngine({
      caller,
      store,
      prompts: new PrismaPromptSource(this.db),
      recall: new LexicalRecall(store, settings.recentWindowTurns),
      logger: this.logger,
    });
    return { engine, store, settings };
  }
}
