import type { Logger } from "@aidp/ai";
import { pinoRedact, pinoSerializers, withLogBindings } from "@aidp/core";
import { pino, type Logger as PinoLogger } from "pino";

/**
 * The process logger. What is never logged (tokens in URLs, message text, addresses, secrets,
 * filenames) is one definition shared with the worker (D-223, packages/core/src/telemetry);
 * `pretty` is development, where addresses and text are left readable and tokens still are not.
 */
export function createLogger(level: string, pretty: boolean): PinoLogger {
  return pino({
    level,
    redact: pinoRedact({ development: pretty }),
    serializers: pinoSerializers(),
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}

/**
 * Adapts pino to the small Logger port the engine uses. Every line carries the tenant, session
 * and user of the request or job it is written under (D-223): the ids come from async-local
 * scope, so the engine's port stays two methods.
 */
export function engineLogger(log: PinoLogger): Logger {
  return withLogBindings({
    warn: (message: string, meta?: Record<string, unknown>) => {
      log.warn(meta ?? {}, message);
    },
    info: (message: string, meta?: Record<string, unknown>) => {
      log.info(meta ?? {}, message);
    },
  });
}
