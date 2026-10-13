import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A titled card: a header row (title, optional description, optional actions on the right) over
 * content that runs to the card's edges, which is what a table or a list wants (D-78). Use `Card`
 * for padded free-form content and this for anything with a title bar.
 */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  headingLevel = 2,
  ...rest
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string | undefined;
  headingLevel?: 2 | 3;
} & Omit<React.ComponentProps<"section">, "title">): React.JSX.Element {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  // Server components cannot call useId; a title-derived id is stable, and `rest.id` wins when a
  // page shows two panels with the same title.
  const id = `${rest.id ?? (typeof title === "string" ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "panel")}-title`;
  return (
    <section
      data-slot="card"
      aria-labelledby={id}
      className={cn("bg-card shadow-card overflow-hidden rounded-lg", className)}
      {...rest}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
        <div className="min-w-0">
          <Heading id={id} className="text-foreground text-[15px] font-semibold tracking-tight">
            {title}
          </Heading>
          {description ? <p className="text-muted-foreground mt-0.5 text-[13px]">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** The heading over a group of tiles or panels on a page. */
export function SectionTitle({
  children,
  className,
  id,
}: {
  children: React.ReactNode;
  className?: string | undefined;
  id?: string | undefined;
}): React.JSX.Element {
  return (
    <h2 id={id} className={cn("text-foreground text-base font-semibold tracking-tight", className)}>
      {children}
    </h2>
  );
}
