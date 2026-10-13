"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * The submit button of a form whose `action` is a server action: it shows the spinner and blocks
 * a second click for as long as the action runs, which a plain button has no way of knowing.
 */
export function SubmitButton(props: Omit<ButtonProps, "type" | "loading">): React.JSX.Element {
  const { pending } = useFormStatus();
  return <Button type="submit" loading={pending} {...props} />;
}
