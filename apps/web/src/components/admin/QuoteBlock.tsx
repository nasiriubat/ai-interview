import { CheckIcon, FileTextIcon, QuoteIcon } from "lucide-react";
import * as React from "react";
import { t } from "@/i18n";

/**
 * One piece of evidence with where it came from (D-372). Provenance is what the API can honestly
 * say: that it is an excerpt from an interview, whether it was anonymised, and the fact it was taken
 * from. It is a `figure` with a `blockquote` and a caption, so a screen reader hears the quote and
 * then its source.
 *
 * Only a `quote` (found word for word in the interview it cites, D-478) is set as a quotation. A
 * `paraphrase` is the fact in the analysis' words, and an `unverified` row is from an analysis made
 * before quotes were checked: both are shown as plain text with a caption that says so, never in
 * quotation marks.
 */
export function QuoteBlock({
  text,
  anonymized = true,
  source,
  kind = "quote",
}: {
  text: string;
  anonymized?: boolean;
  /** A short reference such as "fact 3a9f". Never a name. */
  source?: string | undefined;
  kind?: "quote" | "paraphrase" | "unverified";
}): React.JSX.Element {
  const s = t.ws.quote;
  const quote = kind === "quote";
  const sourceRef = source ? (
    <>
      <span aria-hidden="true">·</span>
      <span className="font-mono">{source}</span>
    </>
  ) : null;
  if (!quote)
    return (
      <figure className="bg-muted/25 relative rounded-lg py-3 pr-4 pl-11">
        <FileTextIcon className="text-muted-foreground absolute top-3.5 left-3.5 size-4" aria-hidden="true" />
        <p className="text-foreground text-sm leading-relaxed text-pretty break-words">{text}</p>
        <figcaption className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
          <span>{kind === "paraphrase" ? s.paraphrase : s.unverified}</span>
          {sourceRef}
        </figcaption>
      </figure>
    );
  return (
    <figure className="bg-muted/50 relative rounded-lg py-3 pr-4 pl-11">
      <QuoteIcon className="text-primary/70 absolute top-3.5 left-3.5 size-5 rotate-180" aria-hidden="true" />
      <blockquote className="text-foreground text-sm leading-relaxed text-pretty break-words">
        {text}
      </blockquote>
      <figcaption className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
        <span>{s.excerpt}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          <CheckIcon className="text-success size-3" aria-hidden="true" />
          {s.verified}
        </span>
        <span aria-hidden="true">·</span>
        <span>{anonymized ? s.anonymised : s.verbatim}</span>
        {sourceRef}
      </figcaption>
    </figure>
  );
}
