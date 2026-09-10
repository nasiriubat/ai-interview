import { pino, type Logger as PinoLogger } from "pino";
import type { Logger } from "@aidp/ai";

export function createLogger(level: string, pretty: boolean): PinoLogger {
  return pino({
    level,
    redact: ["req.headers.authorization", "req.headers.cookie", "*.apiKey", "*.password"],
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}

/** Adapts pino to the small Logger port the engine uses. */
export function engineLogger(log: PinoLogger): Logger {
  return {
    warn: (message, meta) => log.warn(meta ?? {}, message),
    info: (message, meta) => log.info(meta ?? {}, message),
  };
}
