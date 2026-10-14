import { z } from "zod";

/**
 * Zod 4 probes whether `new Function("")` works to decide if it may compile its parsers, and the
 * probe is a script-src violation under a policy without `unsafe-eval`: caught and harmless, but
 * every page then reports one and a real violation hides among them (D-264). The browser build
 * parses small payloads, so the interpreter is the right choice there; this switches the probe
 * off. Imported once, from the root client provider, before any schema parses.
 */
// Browser only: the server process keeps the compiled parsers (it has no policy to violate).
if (typeof window !== "undefined") z.config({ jitless: true });
