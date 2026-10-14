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
  private playing = false;
  private queue: { blob: Blob | undefined; onDone: () => void; onRefused: () => void }[] = [];

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
    this.queue = [];
  }

  /**
   * Plays what was collected. `onDone` runs when it ends, or at once when there is nothing to
   * play; `onRefused` runs first when the browser would not start it (autoplay refused, or a
   * container it cannot decode).
   *
   * `more` says another segment of the same reply follows (D-280): the interviewer's first
   * sentence is played while the rest is still being produced. A segment that arrives while the
   * previous one is playing waits its turn, and `onDone` is called once, after the last segment,
   * so the interview goes back to listening only when the whole reply has been heard.
   */
  play(onDone: () => void, onRefused: () => void, more = false): void {
    const speech = this.pending;
    this.pending = null;
    const blob =
      speech && speech.chunks.length > 0 ? new Blob(speech.chunks, { type: speech.mime }) : undefined;
    const settle = (): void => {
      if (!more) onDone();
    };
    if (!blob) {
      if (!this.playing && this.queue.length === 0) settle();
      else this.queue.push({ blob: undefined, onDone: settle, onRefused });
      return;
    }
    const segment = { blob, onDone: settle, onRefused };
    if (this.playing) this.queue.push(segment);
    else this.start(segment);
  }

  private start(segment: { blob: Blob | undefined; onDone: () => void; onRefused: () => void }): void {
    if (!segment.blob) {
      this.next(segment.onDone);
      return;
    }
    const player = (this.element ??= new Audio());
    const url = URL.createObjectURL(segment.blob);
    this.objectUrl = url;
    this.playing = true;
    const done = (): void => {
      if (this.objectUrl === url) {
        URL.revokeObjectURL(url);
        this.objectUrl = null;
      }
      this.playing = false;
      this.next(segment.onDone);
    };
    player.onended = done;
    player.onerror = done;
    player.src = url;
    player.play().catch(() => {
      segment.onRefused();
      done();
    });
  }

  /** After a segment: the queued one, else report this segment's own completion. */
  private next(finished: () => void): void {
    finished();
    const following = this.queue.shift();
    if (following) this.start(following);
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
    this.playing = false;
    this.queue = [];
  }
}
