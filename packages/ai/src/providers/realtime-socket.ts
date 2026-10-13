import WebSocket from "ws";
import type { RealtimeSocketFactory } from "./types.js";

/**
 * The production socket for streaming adapters: the `ws` package.
 *
 * Not Node's global `WebSocket`. The OpenAI Realtime API authenticates a server-side connection
 * with an `Authorization` header, and the WHATWG `WebSocket` constructor has no way to set one; the
 * only header-free route is the browser's `openai-insecure-api-key.` subprotocol, which puts the
 * key in a place proxies log. Undici's constructor does accept a non-standard `headers` option, but
 * it is untyped, undocumented as stable, and differs across Node releases. `ws` takes headers as a
 * first-class option, is what the API's own WebSocket server already runs on, and is what OpenAI's
 * Node examples use.
 */
export const wsSocketFactory: RealtimeSocketFactory = (url, headers) =>
  new WebSocket(url, { headers, handshakeTimeout: 10_000 });
