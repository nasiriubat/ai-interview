"use client";

import * as React from "react";
import { chunkForSpeech, pickVoice, toSpeakable } from "@/lib/speech";

export interface Speech {
  /** False when the browser cannot speak this language; the listen button is then not shown. */
  supported: boolean;
  /** Id of the message being read, or null. */
  speakingId: string | null;
  speak: (id: string, text: string) => void;
  stop: () => void;
}

/**
 * Reads interviewer messages aloud with the browser's speech synthesis (D-76). One message at a
 * time: starting another stops the first, and unmounting stops everything, so audio never
 * outlives the screen that started it.
 */
export function useSpeech(locale: string): Speech {
  const synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  const [voice, setVoice] = React.useState<SpeechSynthesisVoice | null>(null);
  const [speakingId, setSpeakingId] = React.useState<string | null>(null);
  const run = React.useRef(0);

  React.useEffect(() => {
    if (!synth) return;
    // Voices load asynchronously in Chrome; the list is empty until `voiceschanged` fires.
    const load = (): void => {
      setVoice(pickVoice(synth.getVoices(), locale));
    };
    load();
    synth.addEventListener("voiceschanged", load);
    return () => {
      synth.removeEventListener("voiceschanged", load);
      synth.cancel();
    };
  }, [synth, locale]);

  const stop = React.useCallback(() => {
    run.current += 1;
    synth?.cancel();
    setSpeakingId(null);
  }, [synth]);

  const speak = React.useCallback(
    (id: string, text: string) => {
      if (!synth || !voice) return;
      synth.cancel();
      const mine = ++run.current;
      const chunks = chunkForSpeech(toSpeakable(text));
      if (chunks.length === 0) return;
      setSpeakingId(id);
      chunks.forEach((chunk, i) => {
        const u = new SpeechSynthesisUtterance(chunk);
        u.voice = voice;
        u.lang = voice.lang;
        if (i === chunks.length - 1) {
          u.onend = () => {
            if (run.current === mine) setSpeakingId(null);
          };
        }
        u.onerror = () => {
          if (run.current === mine) setSpeakingId(null);
        };
        synth.speak(u);
      });
    },
    [synth, voice],
  );

  return { supported: synth !== null && voice !== null, speakingId, speak, stop };
}
