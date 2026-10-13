import {
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_TTS_MODEL,
  LIVE_TRANSCRIPTION_MODEL,
  ProviderError,
  createProvider,
  kindSupportsPurpose,
} from "@aidp/ai";
import type { SettingsService } from "@aidp/core";
import { ProviderKindSchema } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import type { ProviderService } from "../providers/service.js";

/**
 * Live voice as one switch with a readiness check (FR-30a, D-77).
 *
 * The cascade needs `transcription` and `tts` routes, and streaming captions need `stt_stream`.
 * An admin who has none of them should not have to learn the routing table to turn the feature
 * on: they give an OpenAI key, it is checked with one cheap authenticated call, and the provider
 * and routes are created for them. Everything reuses the provider service, so the key is encrypted
 * exactly as a provider added by hand would be, and never leaves this service decrypted.
 */

export const VOICE_PURPOSES = ["transcription", "stt_stream", "tts"] as const;
export type VoicePurpose = (typeof VOICE_PURPOSES)[number];

/** What the call cannot run without. Streaming captions are better, not required: D-70 is the rung below. */
export const REQUIRED_FOR_LIVE: readonly VoicePurpose[] = ["transcription", "tts"];

export interface PurposeReadiness {
  ready: boolean;
  providerName?: string;
  model?: string;
  /** Where the route in force was found; null when there is none. */
  scope: "tenant" | "platform" | null;
}

export interface VoiceReadiness {
  liveVoiceEnabled: boolean;
  recordedVoiceEnabled: boolean;
  purposes: Record<VoicePurpose, PurposeReadiness>;
  canEnableLive: boolean;
  /** Required purposes without a working route; empty when live voice can be turned on. */
  missing: VoicePurpose[];
}

export interface ConnectResult {
  readiness: VoiceReadiness;
  providerId: string;
  providerCreated: boolean;
  /** The purposes this call routed to the provider. */
  routed: VoicePurpose[];
}

/** The model each purpose is routed to by the one-step setup; the same models the bootstrap uses. */
const SETUP_MODELS: Record<VoicePurpose, string> = {
  transcription: DEFAULT_TRANSCRIPTION_MODEL,
  stt_stream: LIVE_TRANSCRIPTION_MODEL,
  tts: DEFAULT_TTS_MODEL,
};

const PROVIDER_NAME = "OpenAI (live voice)";

export class VoiceSetupService {
  constructor(
    private readonly deps: {
      db: PrismaClient;
      settings: SettingsService;
      providers: ProviderService;
      /** `OPENAI_BASE_URL`; unset means OpenAI itself. */
      openaiBaseUrl?: string | undefined;
      /** Test seam for the key check; production uses the adapter's `fetch`. */
      fetch?: typeof fetch;
    },
  ) {}

  /** Tenant route first, platform second, exactly as the route resolver reads them. */
  async readiness(companyId: string): Promise<VoiceReadiness> {
    const [routes, values] = await Promise.all([
      this.deps.db.route.findMany({
        where: {
          purpose: { in: [...VOICE_PURPOSES] },
          OR: [{ companyId }, { companyId: null }],
        },
        include: { provider: { select: { name: true, kind: true, enabled: true, companyId: true } } },
      }),
      this.deps.settings.resolveMany(
        ["features.realtimeVoice", "features.recordedVoice"],
        [{ scope: "tenant", scopeId: companyId }],
      ),
    ]);
    const purposes = {} as Record<VoicePurpose, PurposeReadiness>;
    for (const purpose of VOICE_PURPOSES) {
      const row =
        routes.find((r) => r.purpose === purpose && r.companyId === companyId) ??
        routes.find((r) => r.purpose === purpose && r.companyId === null);
      if (!row) {
        purposes[purpose] = { ready: false, scope: null };
        continue;
      }
      const kind = ProviderKindSchema.safeParse(row.provider.kind);
      // A route is only as good as what it points at: a disabled provider, or one that has no audio
      // endpoints at all, would fail the first call the same way no route does.
      const usable =
        row.provider.enabled &&
        (row.provider.companyId === null || row.provider.companyId === companyId) &&
        kind.success &&
        kindSupportsPurpose(kind.data, purpose);
      purposes[purpose] = {
        ready: usable,
        providerName: row.provider.name,
        model: row.model,
        scope: row.companyId === null ? "platform" : "tenant",
      };
    }
    const missing = REQUIRED_FOR_LIVE.filter((p) => !purposes[p].ready);
    return {
      liveVoiceEnabled: values["features.realtimeVoice"] === true,
      recordedVoiceEnabled: values["features.recordedVoice"] === true,
      purposes,
      canEnableLive: missing.length === 0,
      missing,
    };
  }

  /**
   * Checks an OpenAI key, then stores it as this tenant's OpenAI provider and routes the voice
   * purposes to it.
   *
   * Routing rules, so an admin's deliberate choices survive: `stt_stream` and `tts` are routed to
   * the new key unless the tenant already has a working route of its own for them; `transcription`
   * only when nothing, at any scope, can transcribe, because recorded voice depends on it too and a
   * working platform route is somebody's deliberate choice.
   */
  async connectOpenAI(companyId: string, apiKey: string): Promise<ConnectResult> {
    await this.verifyKey(apiKey);
    const before = await this.readiness(companyId);

    const existing = await this.deps.db.provider.findFirst({
      where: { companyId, kind: "openai" },
      orderBy: { createdAt: "asc" },
    });
    const baseUrl = this.deps.openaiBaseUrl;
    const provider = existing
      ? await this.deps.providers.update(companyId, existing.id, {
          apiKey,
          enabled: true,
          ...(baseUrl ? { baseUrl } : {}),
        })
      : await this.deps.providers.create(companyId, {
          kind: "openai",
          name: PROVIDER_NAME,
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
        });

    const routed: VoicePurpose[] = [];
    for (const purpose of VOICE_PURPOSES) {
      const now = before.purposes[purpose];
      const keep = purpose === "transcription" ? now.ready : now.ready && now.scope === "tenant";
      if (keep) continue;
      await this.deps.providers.setRoute(companyId, purpose, {
        providerId: provider.id,
        model: SETUP_MODELS[purpose],
        maxOutputTokens: 0,
      });
      routed.push(purpose);
    }
    return {
      readiness: await this.readiness(companyId),
      providerId: provider.id,
      providerCreated: !existing,
      routed,
    };
  }

  /** Turns live voice on or off for the tenant; on only when the call could actually work. */
  async setLive(companyId: string, enabled: boolean, actorId: string | null): Promise<VoiceReadiness> {
    if (enabled) {
      const now = await this.readiness(companyId);
      if (!now.canEnableLive) {
        throw new AppError(
          "voice_not_ready",
          `Live voice needs a working route for: ${now.missing.join(", ")}`,
          { missing: now.missing },
        );
      }
    }
    await this.deps.settings.set(
      { scope: "tenant", scopeId: companyId },
      { "features.realtimeVoice": enabled },
      actorId,
    );
    return this.readiness(companyId);
  }

  /**
   * One authenticated call that costs nothing: the model list. A refused key is the admin's to
   * fix and gets its own code; anything else is OpenAI having a bad minute.
   *
   * The provider's error text is deliberately not passed on: a 401 from OpenAI quotes part of the
   * key back, and that text would end up in a response body and a log line.
   */
  private async verifyKey(apiKey: string): Promise<void> {
    const adapter = createProvider(
      {
        id: "voice-setup-check",
        companyId: null,
        kind: "openai",
        name: PROVIDER_NAME,
        apiKey,
        headers: {},
        enabled: true,
        ...(this.deps.openaiBaseUrl ? { baseUrl: this.deps.openaiBaseUrl } : {}),
      },
      this.deps.fetch ? { fetch: this.deps.fetch } : {},
    );
    try {
      await adapter.listModels();
    } catch (err) {
      if (err instanceof ProviderError && err.code === "auth")
        throw new AppError("invalid_api_key", "OpenAI did not accept this API key");
      throw new AppError("provider_error", "OpenAI could not be reached to check the key");
    }
  }
}
