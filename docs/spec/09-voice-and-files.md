# 09 Voice and files

## Recorded voice (FR-30)
Browser records; upload; the `transcription` route transcribes; transcript becomes a
user turn; audio retained per turn and playable; deletable with the session.

## Real-time voice (FR-30a): cascade
Streaming speech-to-text (`stt_stream`) → engine turn as usual → streaming
text-to-speech (`tts`), with barge-in. Target: first spoken word within 1.5 s. The
engine stays the brain; every exchange is a normal message. Providers configurable per
tenant (cloud STT and TTS, OpenAI-compatible endpoints, or self-hosted Whisper and
Piper for data residency). Voice behavior: shorter turns, widgets read in short form,
heard choices confirmed, live captions. Latency, interruptions, and transcription
confidence traced per turn and shown in stats. Fallback chain: real-time → recorded →
text, without losing the session.

Speech-to-speech models are a later phase, as an adapter where the voice model must
call an "ask the interviewer" tool for each question so the engine still decides.

## Files (FR-31, FR-32)
PDF, DOCX, MD, TXT, CSV, XLSX, PNG, JPEG, up to 20 MB (knob). Ingested once: text
extraction, image description through `vision_ingest`, summary, embedded chunks. The
interview references the summary and recalls chunks on demand. Every modality produces
the same `Message` with a `modality` field.

## Knobs (ADM-VOICE, ADM-FILES)
Providers per purpose, voice on or off per template, target latency, barge-in on or
off, caption display, file types and size, ingestion model, retention of audio.
