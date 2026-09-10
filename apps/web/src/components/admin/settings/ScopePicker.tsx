"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";

const SCOPES = ["tenant", "template", "campaign", "platform"] as const;

export function ScopePicker({
  scope,
  scopeId,
  allowPlatform,
}: {
  scope: string;
  scopeId: string;
  allowPlatform: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [nextScope, setNextScope] = React.useState(scope);
  const [nextId, setNextId] = React.useState(scopeId);
  const needsId = nextScope === "template" || nextScope === "campaign";
  const s = t.admin.settings;
  return (
    <form
      className="mb-6 flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const params = new URLSearchParams({ scope: nextScope });
        if (needsId && nextId) params.set("scopeId", nextId);
        router.push(`/admin/settings?${params.toString()}`);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="scope">{s.scope}</Label>
        <Select value={nextScope} onValueChange={setNextScope}>
          <SelectTrigger id="scope" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPES.filter((sc) => sc !== "platform" || allowPlatform).map((sc) => (
              <SelectItem key={sc} value={sc}>
                {s.scopes[sc]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {needsId ? (
        <div className="grid gap-1.5">
          <Label htmlFor="scopeId">{s.scopeId}</Label>
          <Input
            id="scopeId"
            value={nextId}
            className="w-64 font-mono text-xs"
            onChange={(e) => {
              setNextId(e.target.value);
            }}
          />
        </div>
      ) : null}
      <Button type="submit" variant="outline">
        {t.app.open}
      </Button>
    </form>
  );
}
