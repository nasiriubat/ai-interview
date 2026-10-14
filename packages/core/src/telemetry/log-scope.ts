import { AsyncLocalStorage } from "node:async_hooks";
import { activeTraceIds } from "./trace.js";

/**
 * Ids that belong on every log line written while a request or a job runs (D-223): the tenant,
 * the session, who is acting, the job. Carried in async-local storage so code that holds only the
 * process-wide logger (the engine's `Logger` port, the job handlers) still writes lines an
 * operator can filter by tenant, without every function growing a logger parameter.
 */
export interface LogBindings {
  tenantId?: string | undefined;
  sessionId?: string | undefined;
  userId?: string | undefined;
  principal?: string | undefined;
  job?: string | undefined;
  jobId?: string | undefined;
  attempt?: number | undefined;
  [key: string]: unknown;
}

const store = new AsyncLocalStorage<LogBindings>();

/** Runs `fn` with `bindings` merged over whatever scope is already active. */
export function runWithLogBindings<T>(bindings: LogBindings, fn: () => T): T {
  return store.run({ ...store.getStore(), ...definedOnly(bindings) }, fn);
}

/** The bindings in force, with the active trace ids when a span is open. */
export function currentLogBindings(): LogBindings {
  const trace = activeTraceIds();
  return { ...store.getStore(), ...(trace ?? {}) };
}

function definedOnly(b: LogBindings): LogBindings {
  return Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
}

/** The engine's `Logger` port shape: message first, metadata second. */
export interface MessageLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Wraps a message-first logger so every line carries the bindings in force when it is written.
 * Explicit metadata wins over a binding of the same name.
 */
export function withLogBindings<L extends MessageLogger>(base: L): L {
  const merge = (meta?: Record<string, unknown>): Record<string, unknown> => ({
    ...currentLogBindings(),
    ...meta,
  });
  return {
    ...base,
    warn: (message: string, meta?: Record<string, unknown>) => {
      base.warn(message, merge(meta));
    },
    info: (message: string, meta?: Record<string, unknown>) => {
      base.info(message, merge(meta));
    },
  };
}
