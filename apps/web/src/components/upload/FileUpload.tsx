"use client";

import {
  CheckCircle2Icon,
  CircleAlertIcon,
  FileIcon,
  RotateCcwIcon,
  UploadCloudIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { IconButton } from "@/components/admin/IconButton";
import { Button } from "@/components/ui/button";
import { useUploadQueue, type UploadContext, type UploadQueue } from "@/components/upload/useUploadQueue";
import { t } from "@/i18n";
import { formatBytes } from "@/lib/attachments";
import { describeAccept, summarize, type UploadItem, type UploadRules } from "@/lib/upload";
import { cn } from "@/lib/utils";

export interface FileUploadProps<R> {
  /** Media types and extensions the server accepts, from its settings. */
  accept: readonly string[];
  /** The server's size limit in MB, from its settings. */
  maxSizeMb: number;
  multiple?: boolean;
  /** Most files at once while listed. Defaults to unlimited when `multiple`, else 1. */
  maxFiles?: number;
  upload: (file: File, ctx: UploadContext) => Promise<R>;
  onUploaded?: (result: R, file: File) => void;
  disabled?: boolean;
  /** The accessible name of the picker; also shown as its heading when `showLabel`. */
  label?: string;
  /** Replaces the generated "PDF, DOCX. Up to 20 MB each." line. */
  hint?: string;
  /** A smaller zone for a dialog or a form row. */
  compact?: boolean;
  className?: string;
}

/**
 * A file picker with a drop zone and a queue (D-343): drag and drop or choose, several at once,
 * each file validated against the server's real limits, sent with a progress bar and a cancel,
 * and left in the list with its reason and a Retry when it fails. Images get a preview. The zone
 * is keyboard operable through its button; progress is a `progressbar` and each outcome is in a
 * polite live region.
 */
export function FileUpload<R>({
  accept,
  maxSizeMb,
  multiple = false,
  maxFiles,
  upload,
  onUploaded,
  disabled = false,
  label,
  hint,
  compact = false,
  className,
}: FileUploadProps<R>): React.JSX.Element {
  const u = t.kit.upload;
  const rules = React.useMemo<UploadRules>(
    () => ({ accept, maxBytes: maxSizeMb * 1024 * 1024 }),
    [accept, maxSizeMb],
  );
  const queue = useUploadQueue<R>({
    rules,
    maxFiles: maxFiles ?? (multiple ? undefined : 1),
    upload,
    ...(onUploaded ? { onUploaded } : {}),
  });
  const input = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);
  const depth = React.useRef(0);
  const hintId = React.useId();
  const name = label ?? (multiple ? u.choose : u.chooseOne);
  const limits = hint ?? u.limits(describeAccept(accept), maxSizeMb);

  const take = (list: FileList | null): void => {
    if (!list || list.length === 0) return;
    queue.add(multiple ? [...list] : [...list].slice(0, 1));
  };

  const summary = summarize(queue.items);

  return (
    <div className={cn("grid gap-3", className)}>
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current += 1;
          setOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          if (!disabled) take(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center gap-2 rounded-lg border-2 border-dashed text-center transition-colors",
          compact ? "px-4 py-4" : "px-6 py-8",
          over ? "border-primary bg-accent" : "border-input bg-muted/30",
          disabled && "opacity-60",
        )}
      >
        <span className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-full">
          <UploadCloudIcon className="size-5" aria-hidden="true" />
        </span>
        <p className="text-foreground text-sm font-medium">{multiple ? u.dropHere : u.dropOne}</p>
        <p className="text-muted-foreground text-xs">{u.or}</p>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-describedby={hintId}
          onClick={() => {
            input.current?.click();
          }}
        >
          {name}
        </Button>
        <p id={hintId} className="text-muted-foreground text-xs">
          {limits}
        </p>
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          multiple={multiple}
          disabled={disabled}
          accept={accept.join(",")}
          onChange={(e) => {
            take(e.target.files);
            // The same file picked again must fire `change` again.
            e.target.value = "";
          }}
        />
      </div>

      {queue.items.length > 0 ? (
        <>
          <ul aria-label={u.queue} className="grid gap-2">
            {queue.items.map((item) => (
              <UploadRow key={item.id} item={item} queue={queue} />
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <p role="status" className="text-muted-foreground text-xs">
              {u.summary(summary.done, summary.total)}
            </p>
            {summary.active === 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={queue.clearFinished}>
                {t.app.close}
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <p role="status" className="sr-only" />
      )}
    </div>
  );
}

function Preview({ file }: { file: File }): React.JSX.Element {
  const [url, setUrl] = React.useState<string | null>(null);
  const image = file.type.startsWith("image/");
  React.useEffect(() => {
    if (!image) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
    };
  }, [file, image]);
  return (
    <span className="bg-muted text-muted-foreground grid size-10 shrink-0 place-items-center overflow-hidden rounded-md">
      {url ? (
        // A local blob URL: no request leaves the browser.
        <img src={url} alt={t.kit.upload.preview(file.name)} className="size-full object-cover" />
      ) : (
        <FileIcon className="size-5" aria-hidden="true" />
      )}
    </span>
  );
}

function UploadRow<R>({ item, queue }: { item: UploadItem<R>; queue: UploadQueue<R> }): React.JSX.Element {
  const u = t.kit.upload;
  const { file, status } = item;
  const label =
    status === "uploading"
      ? u.percent(item.progress)
      : status === "waiting"
        ? u.waiting
        : status === "done"
          ? u.done
          : status === "cancelled"
            ? u.cancelled
            : u.failed;
  return (
    <li
      className={cn(
        "bg-card shadow-card flex items-center gap-3 rounded-lg p-2.5",
        status === "failed" && "ring-destructive/60 ring-1",
      )}
    >
      <Preview file={file} />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-medium" title={file.name}>
          {file.name}
        </p>
        {status === "failed" && item.error ? (
          <p className="text-destructive flex items-start gap-1 text-xs">
            <CircleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span>{item.error}</span>
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            {formatBytes(file.size)} · {label}
          </p>
        )}
        {status === "uploading" || status === "waiting" ? (
          <div
            role="progressbar"
            aria-label={file.name}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(status === "uploading" ? { "aria-valuenow": item.progress } : {})}
            className="bg-muted mt-1.5 h-1.5 overflow-hidden rounded-full"
          >
            <div
              className={cn(
                "bg-primary h-full rounded-full transition-[width] duration-150",
                status === "waiting" && "w-1/4 opacity-40",
              )}
              style={status === "uploading" ? { width: `${String(Math.max(item.progress, 4))}%` } : undefined}
            />
          </div>
        ) : null}
      </div>
      {status === "done" ? (
        <CheckCircle2Icon className="text-success size-5 shrink-0" aria-hidden="true" />
      ) : null}
      <div className="flex shrink-0 items-center">
        {status === "uploading" || status === "waiting" ? (
          <IconButton
            label={u.cancel(file.name)}
            icon={<XIcon />}
            onClick={() => {
              queue.cancel(item.id);
            }}
          />
        ) : null}
        {status === "failed" || status === "cancelled" ? (
          <IconButton
            label={u.retry(file.name)}
            icon={<RotateCcwIcon />}
            onClick={() => {
              queue.retry(item.id);
            }}
          />
        ) : null}
        {status !== "uploading" && status !== "waiting" ? (
          <IconButton
            label={u.remove(file.name)}
            icon={<XIcon />}
            onClick={() => {
              queue.remove(item.id);
            }}
          />
        ) : null}
      </div>
    </li>
  );
}
