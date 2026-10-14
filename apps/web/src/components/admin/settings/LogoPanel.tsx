"use client";

import { ImageUpIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { useBranding } from "@/components/common/Branding";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { notify } from "@/components/common/notify";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { ApiError } from "@/lib/api/errors";
import { LOGO_ACCEPT, LOGO_MAX_BYTES, logoUrl } from "@/lib/branding-shared";
import { cn } from "@/lib/utils";

/** What the person is told about a refused file, in their language, from the API's problem code. */
function messageFor(err: unknown): string {
  const k = t.admin.settings.logo.errors;
  if (err instanceof ApiError) {
    const problem = (err.details as { problem?: unknown } | undefined)?.problem;
    if (err.code === "too_large" || problem === "too_large") return k.size;
    if (problem === "unsupported_type") return k.type;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The site logo, under Branding at platform level (D-430 to D-434). It is not a setting row: the
 * file goes up on its own request the moment it is chosen and comes back as a preview, so it is
 * not part of the category's save bar. The preview is shown on a light and a dark surface, because
 * the logo appears in both themes and a dark wordmark disappears on the dark one.
 */
export function LogoPanel(): React.JSX.Element {
  const s = t.admin.settings.logo;
  const router = useRouter();
  const branding = useBranding();
  const [url, setUrl] = React.useState<string | null>(branding.logoUrl);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const hintId = React.useId();
  const errorId = React.useId();

  React.useEffect(() => {
    setUrl(branding.logoUrl);
  }, [branding.logoUrl]);

  const choose = async (file: File): Promise<void> => {
    setError(null);
    // Checked here for a quick answer; the API reads the bytes and is the authority.
    if (!(LOGO_ACCEPT as readonly string[]).includes(file.type)) {
      setError(s.errors.type);
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError(s.errors.size);
      return;
    }
    setBusy(true);
    try {
      const res = await staffClient.branding.uploadLogo(file);
      setUrl(res.logoVersion ? logoUrl(res.logoVersion) : null);
      notify.success(s.uploaded);
      router.refresh();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await staffClient.branding.removeLogo();
      setUrl(null);
      setConfirm(false);
      notify.success(s.removed);
      router.refresh();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="logo-panel-title" className="bg-card shadow-card grid gap-4 rounded-lg p-5">
      <div className="grid gap-1">
        <h3 id="logo-panel-title" className="text-foreground text-sm font-semibold">
          {s.title}
        </h3>
        <p className="text-muted-foreground text-sm text-pretty">{s.description}</p>
      </div>

      {url ? (
        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={s.current}>
          {(
            [
              ["light", s.onLight, "border-border bg-white"],
              ["dark", s.onDark, "border-transparent bg-neutral-900"],
            ] as const
          ).map(([key, label, surface]) => (
            <figure key={key} className="grid gap-1.5">
              <div className={cn("flex h-20 items-center justify-center rounded-md border px-4", surface)}>
                <img
                  src={url}
                  alt={key === "light" ? branding.productName : ""}
                  className="max-h-10 w-auto max-w-full object-contain"
                />
              </div>
              <figcaption className="text-muted-foreground text-xs">{label}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground bg-muted/50 rounded-md px-4 py-3 text-sm">{s.none}</p>
      )}

      <p id={hintId} className="text-muted-foreground text-xs">
        {s.rules}
      </p>

      {error ? (
        <Alert variant="destructive" id={errorId} aria-live="polite">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <input
          ref={input}
          type="file"
          accept={LOGO_ACCEPT.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void choose(file);
          }}
        />
        <Button
          type="button"
          variant="outline"
          loading={busy}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          onClick={() => input.current?.click()}
        >
          <ImageUpIcon aria-hidden="true" />
          {busy ? s.uploading : url ? s.replace : s.upload}
        </Button>
        {url ? (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setConfirm(true);
            }}
          >
            <Trash2Icon aria-hidden="true" />
            {s.remove}
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={s.confirmTitle}
        description={s.confirmBody}
        confirmLabel={s.remove}
        pending={busy}
        onConfirm={() => void remove()}
      />
    </section>
  );
}
