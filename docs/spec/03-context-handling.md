# 03 Context handling

The engine never re-sends a transcript. Context is assembled in layers every turn.

| Layer | Content | Stability | Size control |
|---|---|---|---|
| 1 Stable prefix | System prompt, template objective, instructions, widget schema | Byte-identical across turns; cache-marked on providers that support it | Fixed |
| 2 Structured state | Coverage, profile, open threads, decisions, facts so far | Changes every turn but stays small | Facts compacted by kind when over budget |
| 3 Rolling summary | Turns older than the window, updated incrementally | Rewritten every N turns | Instruction preserves names, numbers, tools, quotes, decisions verbatim |
| 4 Recent window | Last ten turns verbatim | Sliding | Window size is a knob |
| 5 Recall on demand | Older turns and attachment chunks, embedded | Retrieved by meaning when the engine calls `recall(query)` | Top-k with a token cap |

Rules:
- Facts are extracted into layer 2 continuously (every turn or every few turns, a knob), so nothing important depends on the summary. The summary carries color and continuity only.
- Attachments are ingested once into a summary plus embedded chunks; the summary sits in layer 2, chunks are reached through layer 5.
- In requirements sessions the specification draft itself is layer 2.
- Per-turn input token budget is a knob (default 12,000 tokens); the assembler trims layer 5, then 4, then compacts 3, never 1 or 2.
- Analysis works map-reduce over facts, never over transcripts.
- Provider-side compaction is not used, so every provider behaves the same.

Evals (NFR-06): on fixed 60-turn transcripts, fact recall after summary must not drop
below the threshold set in CI; coverage progression must match the reference.
