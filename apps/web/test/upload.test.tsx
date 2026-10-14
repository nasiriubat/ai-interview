import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { FileUpload } from "@/components/upload/FileUpload";
import { ApiError } from "@/lib/api/errors";
import { xhrFetch } from "@/lib/api/xhr";
import { describeAccept, matchesAccept, refusalFor, uploadErrorMessage } from "@/lib/upload";

const file = (name: string, type: string, size = 100): File => {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
};

describe("upload rules", () => {
  it("matches by media type, wildcard or extension", () => {
    expect(matchesAccept(file("a.pdf", "application/pdf"), ["application/pdf"])).toBe(true);
    expect(matchesAccept(file("a.png", "image/png"), ["image/*"])).toBe(true);
    expect(matchesAccept(file("notes.md", ""), [".md"])).toBe(true);
    expect(matchesAccept(file("a.exe", "application/x-msdownload"), ["application/pdf", ".md"])).toBe(false);
    expect(matchesAccept(file("any", ""), [])).toBe(true);
  });

  it("refuses empty, wrong type and too large, in that order of precedence", () => {
    const rules = { accept: ["application/pdf"], maxBytes: 1000 };
    expect(refusalFor(file("a.pdf", "application/pdf", 0), rules)).toBe("empty");
    expect(refusalFor(file("a.zip", "application/zip", 10), rules)).toBe("type");
    expect(refusalFor(file("a.pdf", "application/pdf", 2000), rules)).toBe("too_large");
    expect(refusalFor(file("a.pdf", "application/pdf", 10), rules)).toBeNull();
  });

  it("says the server's refusals in words", () => {
    expect(uploadErrorMessage(new ApiError(507, "storage_full", "x"), 20)).toMatch(/storage is full/i);
    expect(uploadErrorMessage(new ApiError(413, "too_large", "x"), 20)).toMatch(/20 MB/);
    expect(uploadErrorMessage(new ApiError(400, "validation", "x"), 20)).toMatch(/not accepted/);
    expect(uploadErrorMessage(new ApiError(0, "network_error", "x"), 20)).toMatch(/connection/i);
    expect(uploadErrorMessage(new Error("boom"), 20)).toBe("The upload failed.");
  });

  it("lists what is accepted for people", () => {
    expect(describeAccept(["application/pdf", ".docx", "image/*"])).toBe("PDF, DOCX, IMAGE");
  });
});

describe("FileUpload", () => {
  const accept = ["application/pdf"];

  it("uploads a picked file with progress and reports the result", async () => {
    const user = userEvent.setup();
    const onUploaded = vi.fn();
    const upload = vi.fn(async (_f: File, ctx: { onProgress: (n: number) => void }) => {
      ctx.onProgress(50);
      return "id-1";
    });
    const { container } = render(
      <FileUpload accept={accept} maxSizeMb={1} upload={upload} onUploaded={onUploaded} />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(input!, file("plan.pdf", "application/pdf"));
    await waitFor(() => {
      expect(onUploaded).toHaveBeenCalledWith("id-1", expect.any(File));
    });
    const list = screen.getByRole("list", { name: "Files" });
    expect(within(list).getByText("plan.pdf")).toBeInTheDocument();
    expect(screen.getByText("1 of 1 uploaded")).toBeInTheDocument();
  });

  it("shows a refused file with its reason and never sends it", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const upload = vi.fn();
    const { container } = render(<FileUpload accept={accept} maxSizeMb={1} upload={upload} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(input!, file("big.pdf", "application/pdf", 5 * 1024 * 1024));
    expect(await screen.findByText("Larger than the 1 MB limit.")).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });

  it("keeps a failed upload in the list with the server's reason and a working retry", async () => {
    const user = userEvent.setup();
    const upload = vi
      .fn<(f: File) => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(507, "storage_full", "full"))
      .mockResolvedValueOnce("ok");
    const { container } = render(<FileUpload accept={accept} maxSizeMb={1} upload={upload} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(input!, file("a.pdf", "application/pdf"));
    expect(await screen.findByText(/storage is full/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry a.pdf" }));
    await waitFor(() => {
      expect(screen.getByText("1 of 1 uploaded")).toBeInTheDocument();
    });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("cancels an upload in flight", async () => {
    const user = userEvent.setup();
    const upload = vi.fn(
      (_f: File, ctx: { signal: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const { container } = render(<FileUpload accept={accept} maxSizeMb={1} upload={upload} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(input!, file("a.pdf", "application/pdf"));
    await user.click(await screen.findByRole("button", { name: "Cancel upload of a.pdf" }));
    expect(await screen.findByText(/Cancelled/)).toBeInTheDocument();
  });
});

describe("xhrFetch", () => {
  class FakeXhr {
    static last: FakeXhr;
    upload: {
      onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
    } = {
      onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    status = 200;
    statusText = "OK";
    response = new Blob(['{"ok":true}']);
    responseType = "";
    open = vi.fn();
    setRequestHeader = vi.fn();
    send = vi.fn();
    abort = vi.fn(() => this.onabort?.());
    getAllResponseHeaders = (): string => "content-type: application/json\r\n";
    constructor() {
      FakeXhr.last = this;
    }
  }

  it("reports progress and resolves with a Response", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const seen: number[] = [];
    const pending = xhrFetch("/x", {
      method: "POST",
      body: new FormData(),
      onUploadProgress: (p) => seen.push(p),
    });
    FakeXhr.last.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    FakeXhr.last.onload?.();
    const res = await pending;
    expect(seen).toEqual([25]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    vi.unstubAllGlobals();
  });

  it("rejects with an AbortError when the signal fires", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const controller = new AbortController();
    const pending = xhrFetch("/x", { method: "POST", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    vi.unstubAllGlobals();
  });
});

React;
