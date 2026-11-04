import { loadEnvKey } from "./runtime.js";
import type { SimulatorConfig } from "./simulator.js";

/**
 * Which provider a demo or live run uses, for the product and for the simulated people alike:
 * `LIVE_PROVIDER=meta` runs both on Meta's Model API (MUSE_API_KEY), anything else on OpenRouter
 * (OPENROUTER_API_KEY), as the harness always has. The product side is only the bootstrap key: the
 * product picks its provider from routes like any deployment (D-495).
 */
export type HarnessProvider = "meta" | "openrouter";

export interface Backend {
  provider: HarnessProvider;
  /** The bootstrap environment that creates the platform provider and its default routes. */
  bootstrapEnv: Record<string, string>;
  /** The simulated participant or owner. */
  sim: SimulatorConfig;
}

/** Meta's standard model; never a `-contributor` variant, which lets the vendor train on prompts. */
const META_MODEL = process.env.LIVE_META_MODEL ?? "muse-spark-1.3";

export function harnessBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  if (env.LIVE_PROVIDER === "meta") {
    const apiKey = loadEnvKey("MUSE_API_KEY");
    return {
      provider: "meta",
      bootstrapEnv: { MUSE_API_KEY: apiKey },
      sim: {
        apiKey,
        model: META_MODEL,
        endpoint: {
          url: "https://api.meta.ai/v1/chat/completions",
          // A person answering does not deliberate: the lowest effort the API accepts.
          body: { reasoning_effort: "minimal" },
          reasoningHeadroom: 600,
          price: { inputPerMtok: 1.25, outputPerMtok: 4.25 },
        },
      },
    };
  }
  const apiKey = loadEnvKey("OPENROUTER_API_KEY");
  return {
    provider: "openrouter",
    bootstrapEnv: { OPENROUTER_API_KEY: apiKey },
    sim: { apiKey, model: env.LIVE_MODEL_SIMULATOR ?? "qwen/qwen3-30b-a3b-instruct-2507" },
  };
}
