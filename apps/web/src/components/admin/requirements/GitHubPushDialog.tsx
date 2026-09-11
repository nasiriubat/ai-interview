"use client";

import { ExternalLinkIcon, GitBranchIcon, Loader2Icon } from "lucide-react";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { TextField } from "@/components/admin/forms";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { GitHubPushResult } from "@/lib/api/schemas";
import type { SpecVersionRef } from "@/lib/api/staff";

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Pushes a version's bundle to a GitHub repository. The token is sent once and never stored (contract 18). */
export function GitHubPushDialog({
  sessionId,
  version,
  open,
  onOpenChange,
}: {
  sessionId: string;
  version: SpecVersionRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const s = t.admin.requirements.version.github;
  const action = useAction();
  const [repository, setRepository] = React.useState("");
  const [branch, setBranch] = React.useState("main");
  const [directory, setDirectory] = React.useState("");
  const [token, setToken] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<GitHubPushResult | null>(null);

  const push = (): void => {
    const errs: Record<string, string> = {};
    if (!REPO_RE.test(repository.trim())) errs.repository = s.repositoryHint;
    if (!token.trim()) errs.token = t.app.required;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    void action.run(async () => {
      const r = await staffClient.requirements.versions.github(sessionId, version, {
        repository: repository.trim(),
        token: token.trim(),
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        ...(directory.trim() ? { directory: directory.trim().replace(/^\/+|\/+$/g, "") } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
      });
      setToken("");
      setResult(r);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t.app.close} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{s.title}</DialogTitle>
          <DialogDescription>{s.body}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid gap-3 text-sm">
            <p>{s.done(result.files)}</p>
            <Button asChild variant="outline">
              <a href={result.commitUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLinkIcon /> {s.viewCommit}
              </a>
            </Button>
          </div>
        ) : (
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              push();
            }}
          >
            <TextField
              id="gh-repository"
              label={s.repository}
              value={repository}
              hint={s.repositoryHint}
              error={errors.repository}
              required
              placeholder="owner/name"
              onChange={setRepository}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="gh-branch" label={s.branch} value={branch} onChange={setBranch} />
              <TextField
                id="gh-directory"
                label={s.directory}
                value={directory}
                hint={s.directoryHint}
                onChange={setDirectory}
              />
            </div>
            <TextField
              id="gh-token"
              type="password"
              label={s.token}
              value={token}
              hint={s.tokenHint}
              error={errors.token}
              required
              onChange={setToken}
            />
            <TextField id="gh-message" label={s.message} value={message} onChange={setMessage} />
            <Flash flash={action.flash} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={action.busy}
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                {t.app.cancel}
              </Button>
              <Button type="submit" disabled={action.busy} aria-busy={action.busy}>
                {action.busy ? (
                  <Loader2Icon className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <GitBranchIcon />
                )}
                {action.busy ? s.pushing : s.push}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
