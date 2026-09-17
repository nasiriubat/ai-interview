import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom lacks these; Radix and the message list call them.
if (typeof window !== "undefined") {
  window.HTMLElement.prototype.scrollIntoView = (): void => undefined;
  window.HTMLElement.prototype.hasPointerCapture = (): boolean => false;
  window.HTMLElement.prototype.releasePointerCapture = (): void => undefined;
  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe(): void {
        return undefined;
      }
      unobserve(): void {
        return undefined;
      }
      disconnect(): void {
        return undefined;
      }
    }
    Object.defineProperty(window, "ResizeObserver", { value: ResizeObserverStub, writable: true });
  }

  /*
   * jsdom has no media stack at all. These stubs give the recorder a browser that works, so a
   * test that wants a browser that does not (no `MediaRecorder`, a refused microphone) says so
   * with `vi.stubGlobal` or by replacing `getUserMedia` for that test only.
   */
  class MediaRecorderStub {
    static isTypeSupported(): boolean {
      return true;
    }
    /**
     * The instance a test most recently constructed. The live voice call builds a recorder per
     * utterance from inside its own silence detector, so a test has no other way to reach it.
     */
    static latest: MediaRecorderStub | null = null;
    state: "inactive" | "recording" = "inactive";
    /** The timeslice `start` was given, so a test can check that audio is chunked and not held. */
    timeslice: number | undefined = undefined;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readonly mimeType: string;
    constructor(
      readonly stream: MediaStream,
      options?: { mimeType?: string },
    ) {
      this.mimeType = options?.mimeType ?? "audio/webm";
      MediaRecorderStub.latest = this;
    }
    start(timeslice?: number): void {
      this.state = "recording";
      this.timeslice = timeslice;
    }
    /** What a real recorder does every `timeslice` milliseconds, on demand. */
    requestData(): void {
      this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) });
    }
    stop(): void {
      this.state = "inactive";
      this.requestData();
      this.onstop?.();
    }
  }
  Object.defineProperty(window, "MediaRecorder", {
    value: MediaRecorderStub,
    writable: true,
    configurable: true,
  });

  if (!("mediaDevices" in window.navigator)) {
    const stream = {
      getTracks: (): { stop: () => void }[] => [{ stop: (): void => undefined }],
    };
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { getUserMedia: (): Promise<unknown> => Promise.resolve(stream) },
      writable: true,
      configurable: true,
    });
  }

  // Blob URLs: the attachment player creates one and must revoke it.
  window.URL.createObjectURL = (): string => `blob:stub/${Math.random().toString(36).slice(2)}`;
  window.URL.revokeObjectURL = (): void => undefined;
  window.HTMLMediaElement.prototype.play = (): Promise<void> => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = (): void => undefined;
}
