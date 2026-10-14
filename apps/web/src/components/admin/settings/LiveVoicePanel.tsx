"use client";

import { CheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { isApiError } from "@/lib/api/errors";
import { VOICE_PURPOSES, type VoicePurpose, type VoiceReadiness } from "@/lib/api/schemas";

/** Streaming captions are better, not required: without them a call transcribes per utterance. */
const OPTIONAL: ReadonlySet<VoicePurpose> = new Set(["stt_stream"]);

/**
 * Live voice as one switch with a readiness check (FR-30a, D-77).
 *
 * Turning it on when a route is missing does not fail with an error the admin has to decode: it
 * opens a dialog asking for an OpenAI key, which the API checks, stores encrypted and routes, and
 * then the switch goes on. The checklist says what is in place and where it comes from, so an
 * admin whose platform already provides a voice sees that and is never asked for a key at all.
 */
export function LiveVoicePanel(): React.JSX.Element {
  const s = t.admin.settings.liveVoice;
  const router = useRouter();
  const action = useAction();
  const [readiness, setReadiness] = React.useState<VoiceReadiness | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  /** The dialog was opened by turning the switch on, so a connected key should finish the job. */
  const [enableAfterConnect, setEnableAfterConnect] = React.useState(false);
  const [apiKey, setApiKey] = React.useState("");
  const [keyError, setKeyError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
  const switchId = React.useId();
  const keyId = React.useId();
  const keyHintId = React.useId();
  const keyErrorId = React.useId();

  React.useEffect(() => {
    let live = true;
    staffClient.voice
      .readiness()
      .then((r) => {
        if (live) setReadiness(r);
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const askForKey = (enable: boolean): void => {
    setEnableAfterConnect(enable);
    setApiKey("");
    setKeyError(null);
    setDialogOpen(true);
  };

  const toggle = (enabled: boolean): void => {
    if (enabled && readiness && !readiness.canEnableLive) {
      askForKey(true);
      return;
    }
    let notReady = false;
    void action
      .run(
        async () => {
          try {
            setReadiness(await staffClient.voice.setLive(enabled));
            router.refresh();
          } catch (e) {
            // Someone removed a route since the page loaded: the same answer as a missing one.
            if (isApiError(e) && e.code === "voice_not_ready") notReady = true;
            else throw e;
          }
        },
        enabled ? s.enabled : s.disabled,
      )
      .then(() => {
        if (!notReady) return;
        action.setFlash(null);
        askForKey(true);
      });
  };

  const connect = async (e: React.SyntheticEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (checking || apiKey.trim().length === 0) return;
    setChecking(true);
    setKeyError(null);
    try {
      let next = await staffClient.voice.connectOpenAI(apiKey.trim());
      if (enableAfterConnect && next.canEnableLive) next = await staffClient.voice.setLive(true);
      setReadiness(next);
      setApiKey("");
      setDialogOpen(false);
      action.setFlash({
        kind: "success",
        text: enableAfterConnect && next.liveVoiceEnabled ? s.connectedAndOn : s.connected,
      });
      router.refresh();
    } catch (err) {
      setKeyError(
        isApiError(err) && (err.code === "invalid_api_key" || err.code === "validation")
          ? s.dialog.invalidKey
          : s.dialog.unreachable,
      );
    } finally {
      setChecking(false);
    }
  };

  if (loadFailed) {
    return (
      <Alert variant="destructive" className="mb-4">
        <AlertDescription>{s.loadFailed}</AlertDescription>
      </Alert>
    );
  }

  return (
    <section
      aria-labelledby={`${switchId}-title`}
      className="bg-card shadow-card mb-6 grid gap-3 rounded-xl p-4 md:p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <h2 id={`${switchId}-title`} className="text-foreground text-base font-semibold tracking-tight">
            {s.title}
          </h2>
          <p className="text-muted-foreground text-sm">{s.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={switchId} className="sr-only">
            {s.toggle}
          </Label>
          <Switch
            id={switchId}
            checked={readiness?.liveVoiceEnabled ?? false}
            disabled={!readiness || action.busy}
            onCheckedChange={toggle}
          />
        </div>
      </div>
      <Flash flash={action.flash} />
      {readiness ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">{s.checklist}</h3>
          <ul className="grid gap-1.5">
            {VOICE_PURPOSES.map((purpose) => {
              const p = readiness.purposes[purpose];
              const Icon = p.ready ? CheckIcon : XIcon;
              return (
                <li key={purpose} className="flex flex-wrap items-center gap-2 text-sm">
                  <Icon
                    className={p.ready ? "text-primary size-4" : "text-muted-foreground size-4"}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{s.purposes[purpose]}</span>
                  {OPTIONAL.has(purpose) ? (
                    <span className="text-muted-foreground">({s.optional})</span>
                  ) : null}
                  <span className="text-muted-foreground">
                    {p.ready ? s.ready : s.notReady}
                    {p.ready && p.providerName && p.model ? ` · ${s.via(p.providerName, p.model)}` : ""}
                    {p.ready && p.scope ? ` · ${s.scopes[p.scope]}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          {readiness.liveVoiceEnabled && !readiness.canEnableLive ? (
            // Switched on earlier, and a route has gone since (or never existed): calls still work,
            // but degrade to captions or recording, which nobody would guess from a green switch.
            <Alert variant="warning" role="status" className="mt-1">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription>{s.onButNotReady}</AlertDescription>
            </Alert>
          ) : null}
          {!readiness.canEnableLive || !readiness.purposes.stt_stream.ready ? (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  askForKey(false);
                }}
              >
                {readiness.canEnableLive ? s.addStreaming : s.connectOpenAI}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!checking) setDialogOpen(open);
        }}
      >
        <DialogContent closeLabel={t.app.close}>
          <form onSubmit={(e) => void connect(e)} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{s.dialog.title}</DialogTitle>
              <DialogDescription>{s.dialog.body}</DialogDescription>
            </DialogHeader>
            <p className="text-muted-foreground text-sm">{s.dialog.cost}</p>
            <div className="grid gap-1.5">
              <Label htmlFor={keyId}>{s.dialog.keyLabel}</Label>
              <Input
                id={keyId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                required
                aria-invalid={keyError ? true : undefined}
                aria-describedby={keyError ? `${keyHintId} ${keyErrorId}` : keyHintId}
                onChange={(e) => {
                  setApiKey(e.target.value);
                }}
              />
              <p id={keyHintId} className="text-muted-foreground text-xs">
                {s.dialog.keyHint}
              </p>
              {keyError ? (
                <p id={keyErrorId} className="text-destructive text-sm" role="alert">
                  {keyError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={checking}
                onClick={() => {
                  setDialogOpen(false);
                }}
              >
                {s.dialog.cancel}
              </Button>
              <Button type="submit" disabled={checking || apiKey.trim().length === 0}>
                {checking ? s.dialog.checking : s.dialog.submit}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
