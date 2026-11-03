"use client";

import { FileTextIcon, ImageIcon, Loader2Icon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import * as React from "react";
import { IconButton } from "@/components/admin/IconButton";
import { Panel } from "@/components/admin/Panel";
import { attachmentFailure } from "@/components/participant/AttachmentList";
import { FileUpload } from "@/components/upload/FileUpload";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { errorMessage } from "@/lib/api/errors";
import type { CampaignDocument, CampaignDocumentList } from "@/lib/api/schemas";
import { formatBytes } from "@/lib/attachments";

/** How often a document still being read is asked about. */
const POLL_MS = 3000;

/**
 * The campaign's background documents (D-491): an org chart, process descriptions, the tools
 * already in use. The interviewer reads their summaries as background and the analysis as context;
 * neither treats them as something participants said. Administrators add and remove them.
 */
export function CampaignDocumentsPanel({
  campaignId,
  initial,
  canEdit,
}: {
  campaignId: string;
  initial: CampaignDocumentList;
  canEdit: boolean;
}): React.JSX.Element {
  const s = t.admin.campaigns.documents;
  const [documents, setDocuments] = React.useState<CampaignDocument[]>(initial.documents);
  const [error, setError] = React.useState<string | null>(null);
  const pending = documents.some((d) => d.status === "pending");

  React.useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      staffClient.campaigns.documents
        .list(campaignId)
        .then((r) => {
          setDocuments(r.documents);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [pending, campaignId]);

  const remove = (doc: CampaignDocument): void => {
    setError(null);
    staffClient.campaigns.documents
      .remove(campaignId, doc.id)
      .then(() => {
        setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
      })
      .catch((e: unknown) => {
        setError(errorMessage(e, t.app.unknownError));
      });
  };

  const full = documents.length >= initial.uploads.maxDocuments;
  return (
    <Panel id="campaign-documents" title={s.title} description={s.description}>
      <div className="grid gap-4 p-5">
        {documents.length > 0 ? (
          <ul className="grid gap-2">
            {documents.map((d) => (
              <li key={d.id} className="bg-muted/50 flex items-start gap-3 rounded-lg px-3 py-2.5">
                {d.kind === "image" ? (
                  <ImageIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <FileTextIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-sm font-medium">{d.filename}</p>
                  <p className="text-muted-foreground text-xs">
                    {formatBytes(d.sizeBytes)} ·{" "}
                    {d.status === "pending" ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2Icon className="size-3 motion-safe:animate-spin" aria-hidden="true" />
                        {s.reading}
                      </span>
                    ) : d.status === "failed" ? (
                      <span className="text-destructive inline-flex items-center gap-1">
                        <TriangleAlertIcon className="size-3" aria-hidden="true" />
                        {attachmentFailure(d.error)}
                      </span>
                    ) : (
                      s.ready
                    )}
                  </p>
                  {d.status === "ready" && d.summary ? (
                    <p className="text-body mt-1 line-clamp-3 text-[13px] leading-snug">{d.summary}</p>
                  ) : null}
                </div>
                {canEdit ? (
                  <IconButton
                    label={s.remove(d.filename)}
                    icon={<Trash2Icon />}
                    onClick={() => {
                      remove(d);
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{canEdit ? s.emptyAdmin : s.empty}</p>
        )}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {canEdit && !full ? (
          <FileUpload
            multiple
            compact
            maxFiles={initial.uploads.maxDocuments - documents.length}
            accept={initial.uploads.allowedTypes}
            maxSizeMb={initial.uploads.maxSizeMb}
            label={s.add}
            upload={(file, ctx) =>
              staffClient.campaigns.documents.upload(campaignId, file, {
                signal: ctx.signal,
                onProgress: ctx.onProgress,
              })
            }
            onUploaded={(doc) => {
              setDocuments((prev) => [...prev.filter((d) => d.id !== doc.id), doc]);
            }}
          />
        ) : null}
        {canEdit && full ? (
          <p className="text-muted-foreground text-xs">{s.full(initial.uploads.maxDocuments)}</p>
        ) : null}
        <p className="text-muted-foreground text-xs leading-snug">{s.note}</p>
      </div>
    </Panel>
  );
}
