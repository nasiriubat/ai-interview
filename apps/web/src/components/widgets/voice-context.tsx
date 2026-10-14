"use client";

import * as React from "react";

/**
 * What a widget needs to take speech into one of its fields (D-239). Provided by the interview
 * screen only when recorded voice is on and no call is using the microphone; absent, the field is
 * a plain text input. A context rather than a prop: five widgets render the same field and none
 * of them has any business with the transport.
 */
export interface WidgetVoice {
  transcribe: (audio: Blob, durationMs: number) => Promise<string>;
}

const WidgetVoiceContext = React.createContext<WidgetVoice | null>(null);

export const WidgetVoiceProvider = WidgetVoiceContext.Provider;

export function useWidgetVoice(): WidgetVoice | null {
  return React.useContext(WidgetVoiceContext);
}
