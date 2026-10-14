import { QuoteIcon } from "lucide-react";
import * as React from "react";
import { t } from "@/i18n";

/**
 * One quoted answer with where it came from (D-372). Provenance is what the API can honestly say:
 * that it is an excerpt from an interview, whether it was anonymised, and the fact it was taken
 * from. It is a `figure` with a `blockquote` and a caption, so a screen reader hears the quote and
 * then its source.
 */
export function QuoteBlock({
  text,
  anonymized = true,
  source,
}: {
  text: string;
  anonymized?: boolean;
  /** A short reference such as "fact 3a9f". Never a name. */
  source?: string | undefined;
}): React.JSX.Element {
  const s = t.ws.quote;
  return (
    <figure className="bg-muted/50 relative rounded-lg py-3 pr-4 pl-11">
      <QuoteIcon className="text-primary/70 absolute top-3.5 left-3.5 size-5 rotate-180" aria-hidden="true" />
      <blockquote className="text-foreground text-sm leading-relaxed text-pretty break-words">
        {text}
      </blockquote>
      <figcaption className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
        <span>{s.excerpt}</span>
        <span aria-hidden="true">·</span>
        <span>{anonymized ? s.anonymised : s.verbatim}</span>
        {source ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{source}</span>
          </>
        ) : null}
      </figcaption>
    </figure>
  );
}
