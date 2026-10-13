/**
 * Playback of the interviewer's voice, buffered rather than incremental.
 *
 * The audio of one `speech_start`/`speech_end` pair is collected into a Blob and played from an
 * object URL, so speech begins when the server has finished synthesizing rather than when the
 * first byte lands. `MediaSource` would start sooner, but it needs codec-exact `SourceBuffer` mime
 * strings, is absent from Safari on iPhone, and a mismatch there fails silently: an interviewer
 * that says nothing at all is a worse bug than one that starts a moment late. The server measures
 * `first_word` from its own side, so the spec's latency number is still honest.
 */
export class Player {
  private element: HTMLAudioElement | null = null;
  private pending: { mime: string; chunks: Blob[] } | null = null;
  private objectUrl: string | null = null;

  /** Audio frames that arrive from now on belong to a speech of this type. */
  begin(mime: string): void {
    this.pending = { mime, chunks: [] };
  }

  /** One binary frame of the speech in flight; ignored when none is. */
  push(data: unknown): void {
    const speech = this.pending;
    if (!speech) return;
    if (data instanceof Blob) speech.chunks.push(data);
    else if (data instanceof ArrayBuffer) speech.chunks.push(new Blob([data]));
    else if (ArrayBuffer.isView(data)) speech.chunks.push(new Blob([data.buffer as ArrayBuffer]));
  }

  /** Forgets the speech in flight without playing it (the server said it was interrupted). */
  discard(): void {
    this.pending = null;
  }

  /**
   * Plays what was collected. `onDone` runs when it ends, or at once when there is nothing to
   * play; `onRefused` runs first when the browser would not start it (autoplay refused, or a
   * container it cannot decode).
   */
  play(onDone: () => void, onRefused: () => void): void {
    const speech = this.pending;
    this.pending = null;
    if (!speech || speech.chunks.length === 0) {
      onDone();
      return;
    }
    const player = (this.element ??= new Audio());
    const url = URL.createObjectURL(new Blob(speech.chunks, { type: speech.mime }));
    this.objectUrl = url;
    const done = (): void => {
      if (this.objectUrl === url) {
        URL.revokeObjectURL(url);
        this.objectUrl = null;
      }
      onDone();
    };
    player.onended = done;
    player.onerror = done;
    player.src = url;
    player.play().catch(() => {
      onRefused();
      done();
    });
  }

  /** Silences the player and frees what it held. */
  stop(): void {
    const player = this.element;
    if (player) {
      player.onended = null;
      player.onerror = null;
      player.pause();
      player.removeAttribute("src");
    }
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.pending = null;
  }
}
