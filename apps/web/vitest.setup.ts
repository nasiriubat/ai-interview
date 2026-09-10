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
}
