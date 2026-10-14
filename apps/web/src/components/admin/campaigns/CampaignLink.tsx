"use client";

import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import * as React from "react";
import { QrCode, qrSvgDocument } from "@/components/admin/campaigns/QrCode";
import { Panel } from "@/components/admin/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";

/**
 * The share link, the way to copy it, and a QR code of it for posters and slides (D-237).
 * The copy button's label flips and a separate polite status announces the result: a live region
 * on the button itself is announced inconsistently when the button's own text changes.
 */
export function CampaignLink({
  name,
  url,
  status,
}: {
  name: string;
  url: string | undefined;
  status: string;
}): React.JSX.Element {
  const s = t.admin.campaigns;
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = (): void => {
    if (!url) return;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => undefined);
  };

  const hint = status === "open" ? s.shareBody : status === "closed" ? s.linkClosedHint : s.linkDraftHint;

  return (
    <Panel title={s.shareTitle} description={url ? hint : undefined}>
      {url ? (
        <div className="grid gap-5 px-5 py-4 md:grid-cols-[1fr_auto] md:items-start">
          <div className="grid gap-1.5">
            <Label htmlFor="campaign-link">{s.linkTitle}</Label>
            <div className="flex gap-2">
              <Input
                id="campaign-link"
                readOnly
                value={url}
                className="font-mono text-xs"
                onFocus={(e) => {
                  e.currentTarget.select();
                }}
              />
              <Button type="button" variant="outline" onClick={copy}>
                {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                {copied ? s.linkCopied : s.copyLink}
              </Button>
            </div>
            <p role="status" className="sr-only">
              {copied ? s.linkCopied : ""}
            </p>
          </div>
          <div className="flex items-start gap-4 md:flex-col md:items-center">
            <div className="shadow-control size-36 shrink-0 rounded-md bg-white p-1">
              <QrCode value={url} label={s.qrLabel(name)} className="size-full" />
            </div>
            <div className="grid max-w-48 gap-2">
              <p className="text-muted-foreground text-xs">{s.qrHint}</p>
              <Button asChild variant="outline" size="sm">
                <a
                  href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvgDocument(url))}`}
                  download={`${name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "campaign"}-qr.svg`}
                >
                  <DownloadIcon aria-hidden="true" /> {s.qrDownload}
                </a>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground px-5 py-4 text-sm">{hint}</p>
      )}
    </Panel>
  );
}
