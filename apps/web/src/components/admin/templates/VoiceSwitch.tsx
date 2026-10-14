"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";

/**
 * The template's own voice switch (`voice.enabled`, D-186). It is stored as a template-scoped
 * setting, so it follows the template through new versions, and it can only turn voice off: the
 * organization's setting still has to allow it, which the hint says.
 */
export function VoiceSwitch({
  templateId,
  initial,
  disabled = false,
}: {
  templateId: string;
  initial: boolean;
  /** A built-in template is the platform's to change, not the organization's. */
  disabled?: boolean;
}): React.JSX.Element {
  const s = t.admin.templates.voice;
  const router = useRouter();
  const action = useAction();
  const [enabled, setEnabled] = React.useState(initial);
  const id = React.useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{s.title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="flex items-center gap-3">
          <Switch
            id={id}
            checked={enabled}
            disabled={disabled || action.busy}
            aria-describedby={`${id}-hint`}
            onCheckedChange={(next) => {
              const previous = enabled;
              setEnabled(next);
              void action
                .run(async () => {
                  await staffClient.settings.put(
                    { scope: "template", scopeId: templateId },
                    { "voice.enabled": next },
                  );
                  router.refresh();
                }, s.saved)
                .then((ok) => {
                  if (!ok) setEnabled(previous);
                });
            }}
          />
          <Label htmlFor={id}>{s.label}</Label>
        </div>
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {s.hint}
        </p>
        <Flash flash={action.flash} />
      </CardContent>
    </Card>
  );
}
