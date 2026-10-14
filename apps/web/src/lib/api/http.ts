import type { z } from "zod";
import { ApiError, apiErrorFromResponse } from "./errors";
import { xhrFetch, type ProgressInit } from "./xhr";

/**
 * A transport knows how to reach the API for one principal: where the base URL is and
 * which credential to attach. Endpoint modules are transport-agnostic so the same code
 * runs in server components (direct to the API with the cookie token) and in the browser
 * (through the Next route-handler proxies, so tokens never reach client JavaScript).
 */
export interface Transport {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions<T> {
  method?: Method;
  path: string;
  /** Anything but `FormData` is sent as JSON; a `FormData` body is sent as multipart. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  schema?: z.ZodType<T>;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  /** Upload progress, 0 to 100 (D-343). Makes the browser transport use XMLHttpRequest for this request. */
  onUploadProgress?: ((percent: number) => void) | undefined;
}

/**
 * Encodes the body and sets the matching content type, except for `FormData`: multipart needs a
 * boundary in the header, and only the runtime that serializes the body knows what it is. Setting
 * `Content-Type` ourselves there would produce a body no server can parse.
 */
function encodeBody(body: unknown, headers: Record<string, string>): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (body instanceof FormData) return body;
  headers["Content-Type"] = "application/json";
  return JSON.stringify(body);
}

export function withQuery(path: string, query?: RequestOptions<unknown>["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Performs a JSON request, unwraps the API error envelope, and validates the body when a schema is given. */
export async function request<T = unknown>(transport: Transport, opts: RequestOptions<T>): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  const body = encodeBody(opts.body, headers);
  let res: Response;
  try {
    res = await transport.fetch(withQuery(opts.path, opts.query), {
      method: opts.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onUploadProgress ? { onUploadProgress: opts.onUploadProgress } : {}),
    });
  } catch (e) {
    // A person cancelling is not a failure of the network: let the caller see the abort itself.
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network_error", e instanceof Error ? e.message : "Network error");
  }
  if (!res.ok) throw await apiErrorFromResponse(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : undefined;
  if (!opts.schema) return json as T;
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      res.status,
      "invalid_response",
      `Unexpected response shape for ${opts.path}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** Performs a request and returns the raw response for streaming bodies (SSE). */
export async function requestStream(
  transport: Transport,
  opts: Omit<RequestOptions<never>, "schema">,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: "text/event-stream", ...opts.headers };
  const body = encodeBody(opts.body, headers);
  let res: Response;
  try {
    res = await transport.fetch(withQuery(opts.path, opts.query), {
      method: opts.method ?? "POST",
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    throw new ApiError(0, "network_error", e instanceof Error ? e.message : "Network error");
  }
  if (!res.ok) throw await apiErrorFromResponse(res);
  return res;
}

/** Performs a request and returns the body as a blob: uploaded bytes, not JSON. */
export async function requestBlob(
  transport: Transport,
  opts: Omit<RequestOptions<never>, "schema" | "body">,
): Promise<Blob> {
  let res: Response;
  try {
    res = await transport.fetch(withQuery(opts.path, opts.query), {
      method: opts.method ?? "GET",
      headers: { Accept: "*/*", ...opts.headers },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    throw new ApiError(0, "network_error", e instanceof Error ? e.message : "Network error");
  }
  if (!res.ok) throw await apiErrorFromResponse(res);
  return await res.blob();
}

/** A transport that prefixes a base URL and attaches static headers. */
export function createTransport(
  baseUrl: string,
  headers: () => Record<string, string> = () => ({}),
): Transport {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    fetch: (path, init) => {
      const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
      const merged = {
        ...init,
        headers: { ...headers(), ...(init?.headers as Record<string, string> | undefined) },
        cache: "no-store",
      } as ProgressInit;
      if (merged.onUploadProgress && typeof XMLHttpRequest !== "undefined") return xhrFetch(url, merged);
      return fetch(url, merged);
    },
  };
}
