/**
 * `fetch` has no upload progress, so an upload that wants a progress bar goes through
 * `XMLHttpRequest` and comes back as an ordinary `Response`: everything above the transport
 * (error envelope, schema validation) is unchanged (D-343). Used only when the caller asks for
 * progress; every other request stays on `fetch`.
 */
export interface ProgressInit extends RequestInit {
  /** 0 to 100, called as the request body is sent. */
  onUploadProgress?: ((percent: number) => void) | undefined;
}

export function xhrFetch(url: string, init: ProgressInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const { signal, onUploadProgress } = init;
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    xhr.open(init.method ?? "GET", url);
    xhr.responseType = "blob";
    const headers = init.headers as Record<string, string> | undefined;
    for (const [name, value] of Object.entries(headers ?? {})) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (e): void => {
      if (e.lengthComputable && onUploadProgress) {
        onUploadProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onload = (): void => {
      const responseHeaders = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
        const at = line.indexOf(":");
        if (at > 0) responseHeaders.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
      // 204 and 304 may not carry a body in the `Response` constructor.
      const bodyless = xhr.status === 204 || xhr.status === 304;
      resolve(
        new Response(bodyless ? null : (xhr.response as Blob), {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: responseHeaders,
        }),
      );
    };
    xhr.onerror = (): void => {
      reject(new TypeError("Network error"));
    };
    xhr.ontimeout = (): void => {
      reject(new TypeError("Network timeout"));
    };
    xhr.onabort = (): void => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener(
      "abort",
      () => {
        xhr.abort();
      },
      { once: true },
    );
    xhr.send((init.body ?? null) as XMLHttpRequestBodyInit | null);
  });
}
