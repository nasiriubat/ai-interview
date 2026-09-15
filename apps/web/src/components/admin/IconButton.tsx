"use client";

import Link from "next/link";
import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface CommonProps {
  /** The action's name: the tooltip text and the accessible name of the control. */
  label: string;
  /**
   * The rendered icon — `icon={<EyeIcon />}`, not `icon={EyeIcon}`.
   *
   * This file is a client component, and a component *type* is a function, which React refuses to
   * serialize across the server/client boundary: a server page passing `icon={EyeIcon}` crashed
   * the whole route with the unhelpful minified error #441, and only at run time, on that page.
   * An element is data, so it crosses fine, and the type now rejects the broken form at compile
   * time on every page rather than in the browser on one.
   */
  icon: React.ReactNode;
  variant?: ButtonProps["variant"];
  size?: "icon" | "icon-sm";
  className?: string | undefined;
  disabled?: boolean | undefined;
}

export type IconButtonProps = CommonProps &
  (
    | { onClick: () => void; href?: undefined; external?: undefined; type?: "button" | "submit" }
    | { href: string; external?: boolean | undefined; onClick?: undefined; type?: undefined }
  );

/**
 * The single shape of an action inside an admin table: a lucide icon, an accessible name,
 * and the same name in a tooltip for sighted users. Destructive actions keep their own
 * confirmation dialog around this button.
 */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "icon-sm",
  className,
  disabled,
  ...rest
}: IconButtonProps): React.JSX.Element {
  // The button carries the accessible name, so the glyph itself is hidden rather than announced
  // twice. A wrapper does that without needing to reach into whatever element was passed in.
  const inner = (
    <span aria-hidden="true" className="contents">
      {icon}
    </span>
  );
  const button =
    rest.href !== undefined ? (
      <Button asChild variant={variant} size={size} className={className} aria-label={label}>
        {rest.external ? (
          <a href={rest.href} target="_blank" rel="noopener">
            {inner}
          </a>
        ) : (
          <Link href={rest.href}>{inner}</Link>
        )}
      </Button>
    ) : (
      <Button
        type={rest.type ?? "button"}
        variant={variant}
        size={size}
        className={className}
        aria-label={label}
        disabled={disabled}
        onClick={rest.onClick}
      >
        {inner}
      </Button>
    );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Wraps a control that opens its own dialog (delete, archive) in the same tooltip. */
export function IconTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The row of actions at the end of a table row. */
export function RowActions({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex items-center justify-end gap-0.5">{children}</div>;
}
