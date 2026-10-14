"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Panel } from "@/components/admin/Panel";
import { notify } from "@/components/common/notify";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";

/**
 * The template's own voice switch (`voice.enabled`, D-186). It is stored as a template-scoped
 * setting, so it follows the template through new versions, and it can only turn voice off: the
 * organization's setting still has to allow it, which the hint says. It saves on change, so the
 * result is a toast and a failure puts the switch back (D-363).
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
  const [busy, setBusy] = React.useState(false);
  const [enabled, setEnabled] = React.useState(initial);
  const id = React.useId();

  const save = (next: boolean): void => {
    const previous = enabled;
    setEnabled(next);
    setBusy(true);
    staffClient.settings
      .put({ scope: "template", scopeId: templateId }, { "voice.enabled": next })
      .then(() => {
        notify.success(s.saved);
        router.refresh();
      })
      .catch((e: unknown) => {
        setEnabled(previous);
        notify.error(e, {
          retry: () => {
            save(next);
          },
        });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Panel title={s.title}>
      <div className="grid gap-2 px-5 py-4">
        <div className="flex items-center gap-3">
          <Switch
            id={id}
            checked={enabled}
            disabled={disabled || busy}
            aria-describedby={`${id}-hint`}
            onCheckedChange={save}
          />
          <Label htmlFor={id}>{s.label}</Label>
        </div>
        <p id={`${id}-hint`} className="text-muted-foreground text-[13px]">
          {disabled ? t.admin.templates.voice.builtinHint : s.hint}
        </p>
      </div>
    </Panel>
  );
}
