import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Player } from "@/hooks/live-voice/playback";

/** A stand-in for HTMLAudioElement that lets the test end playback by hand. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
  played: string[] = [];
  constructor() {
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.played.push(this.src);
    return Promise.resolve();
  }
  pause(): void {}
  removeAttribute(): void {}
  end(): void {
    this.onended?.();
  }
}

function segment(player: Player, text: string): void {
  player.begin("audio/ogg");
  player.push(new Uint8Array([text.length, 1, 2]));
}

describe("playback of a reply in segments (D-280)", () => {
  let counter = 0;
  beforeEach(() => {
    FakeAudio.instances = [];
    counter = 0;
    vi.stubGlobal("Audio", FakeAudio);
    URL.createObjectURL = () => `blob:test/${++counter}`;
    URL.revokeObjectURL = () => undefined;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("plays the first segment at once, queues the second behind it, and finishes once", () => {
    const player = new Player();
    const done = vi.fn();

    segment(player, "first sentence");
    player.play(done, vi.fn(), true);
    const audio = FakeAudio.instances[0] as FakeAudio;
    expect(audio.played).toEqual(["blob:test/1"]);

    // The rest arrives while the first is still playing: it waits, and nothing is reported yet.
    segment(player, "the rest");
    player.play(done, vi.fn(), false);
    expect(audio.played).toEqual(["blob:test/1"]);
    expect(done).not.toHaveBeenCalled();

    audio.end();
    expect(audio.played).toEqual(["blob:test/1", "blob:test/2"]);
    expect(done).not.toHaveBeenCalled();

    audio.end();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("reports the end when the last segment arrives after the first has finished", () => {
    const player = new Player();
    const done = vi.fn();

    segment(player, "first sentence");
    player.play(done, vi.fn(), true);
    const audio = FakeAudio.instances[0] as FakeAudio;
    audio.end();
    expect(done).not.toHaveBeenCalled();

    segment(player, "the rest");
    player.play(done, vi.fn(), false);
    expect(audio.played).toEqual(["blob:test/1", "blob:test/2"]);
    audio.end();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("drops queued segments when the speech is discarded", () => {
    const player = new Player();
    const done = vi.fn();
    segment(player, "first");
    player.play(done, vi.fn(), true);
    segment(player, "second");
    player.play(done, vi.fn(), false);
    player.discard();
    const audio = FakeAudio.instances[0] as FakeAudio;
    audio.end();
    expect(audio.played).toEqual(["blob:test/1"]);
  });
});
