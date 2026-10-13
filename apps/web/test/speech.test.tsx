import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "@/components/participant/MessageList";
import type { Speech } from "@/hooks/useSpeech";
import { chunkForSpeech, pickVoice, toSpeakable } from "@/lib/speech";

describe("toSpeakable", () => {
  it("drops markup that would be read out as symbols", () => {
    expect(toSpeakable("**How often** do you do `this`?\n- daily\n- weekly")).toBe(
      "How often do you do this? daily weekly",
    );
    expect(toSpeakable("See [the guide](https://x.y) first")).toBe("See the guide first");
  });
});

describe("chunkForSpeech", () => {
  it("splits on sentence ends", () => {
    expect(chunkForSpeech("First one. Second one? Third!")).toEqual(["First one.", "Second one?", "Third!"]);
  });

  it("cuts a sentence longer than the limit at a space, never mid-word", () => {
    const long = `${"word ".repeat(80)}end.`;
    const chunks = chunkForSpeech(long, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " ").trim());
    expect(chunks.every((c) => !c.endsWith("wor"))).toBe(true);
  });
});

describe("pickVoice", () => {
  const voices = [
    { lang: "en-US", name: "Fred", default: true },
    { lang: "en-GB", name: "Google UK English Female" },
    { lang: "fi-FI", name: "Satu" },
    { lang: "fi_FI", name: "Microsoft Noora Online (Natural)" },
  ];

  it("prefers higher-quality voices for the language", () => {
    expect(pickVoice(voices, "fi")?.name).toBe("Microsoft Noora Online (Natural)");
    expect(pickVoice(voices, "en")?.name).toBe("Google UK English Female");
  });

  it("prefers the exact region when one is asked for", () => {
    expect(
      pickVoice(
        [
          { lang: "en-US", name: "A" },
          { lang: "en-GB", name: "B" },
        ],
        "en-GB",
      )?.name,
    ).toBe("B");
  });

  it("returns null rather than reading a language with the wrong voice", () => {
    expect(pickVoice(voices, "sv")).toBeNull();
    expect(pickVoice([], "en")).toBeNull();
  });
});

describe("MessageBubble listen button", () => {
  function speech(overrides: Partial<Speech> = {}): Speech {
    return { supported: true, speakingId: null, speak: vi.fn(), stop: vi.fn(), ...overrides };
  }

  it("reads an interviewer message aloud", async () => {
    const s = speech();
    render(<MessageBubble message={{ id: "m1", role: "assistant", content: "How is work?" }} speech={s} />);
    await userEvent.click(screen.getByRole("button", { name: "Read this question aloud" }));
    expect(s.speak).toHaveBeenCalledWith("m1", "How is work?");
  });

  it("offers stop while that message is being read", async () => {
    const s = speech({ speakingId: "m1" });
    render(<MessageBubble message={{ id: "m1", role: "assistant", content: "How is work?" }} speech={s} />);
    const b = screen.getByRole("button", { name: "Stop reading" });
    expect(b).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(b);
    expect(s.stop).toHaveBeenCalled();
  });

  it("is not offered on the participant's own messages, while streaming, or when unsupported", () => {
    const { rerender } = render(
      <MessageBubble message={{ id: "u1", role: "user", content: "Fine" }} speech={speech()} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <MessageBubble message={{ id: "m2", role: "assistant", content: "Th" }} streaming speech={speech()} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <MessageBubble
        message={{ id: "m3", role: "assistant", content: "Q" }}
        speech={speech({ supported: false })}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
