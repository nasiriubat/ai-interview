/**
 * The capture half of streaming captions (FR-30a, D-77): an AudioWorklet that turns the
 * microphone into PCM16 at 24 kHz, mono, in small frames, which is the only format the OpenAI
 * Realtime transcription API accepts.
 *
 * Why a worklet rather than an `AudioContext({ sampleRate: 24000 })`: Firefox refuses to connect a
 * microphone to a context whose rate differs from the device's, so the context runs at whatever
 * the hardware gives (usually 48 or 44.1 kHz) and the resampling happens here, off the main
 * thread, where a busy React render cannot drop samples.
 *
 * Why inline source rather than a file under `public/`: the processor is a few lines, it has to
 * agree exactly with the server's frame format, and keeping it next to the constants it uses means
 * one change moves both. It is loaded from a Blob URL, so a Content-Security-Policy added later
 * must allow `blob:` in `script-src` (or this moves to a file).
 *
 * Downsampling is a box filter: every output sample is the mean of the input samples that fall
 * inside it. That is a crude low-pass, but ample for speech going to a recognizer, and it handles
 * the non-integer 44.1 → 24 kHz ratio without drift because the fractional position carries over
 * between render blocks.
 */

export const PCM_WORKLET_NAME = "aidp-pcm-capture";

/** Sent to the server in frames this long: small enough for live captions, large enough to be cheap. */
export const PCM_FRAME_MS = 80;

export const PCM_WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.target = o.targetRate || 24000;
    this.ratio = sampleRate / this.target;
    this.size = Math.max(1, Math.round((this.target * (o.frameMs || ${PCM_FRAME_MS})) / 1000));
    this.frame = new Int16Array(this.size);
    this.filled = 0;
    this.t = 0;
    this.sum = 0;
    this.n = 0;
  }
  emit(value) {
    const s = value > 1 ? 1 : value < -1 ? -1 : value;
    this.frame[this.filled++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    if (this.filled === this.size) {
      this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
      this.frame = new Int16Array(this.size);
      this.filled = 0;
    }
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i];
      this.n += 1;
      this.t += 1;
      let emitted = false;
      while (this.t >= this.ratio) {
        this.t -= this.ratio;
        this.emit(this.sum / this.n);
        emitted = true;
      }
      if (emitted) {
        this.sum = 0;
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("${PCM_WORKLET_NAME}", PcmCapture);
`;
