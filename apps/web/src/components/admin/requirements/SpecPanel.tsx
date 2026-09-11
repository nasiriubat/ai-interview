"use client";

import * as React from "react";
import { FindingsList } from "./FindingsList";
import { SpecSections } from "./SpecSections";
import { VersionsPanel } from "./VersionsPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { t } from "@/i18n";
import type { LiveSpec, SessionInvitation, SpecVersionSummary } from "@/lib/api/schemas";

/** The right-hand panel of the workspace: Spec, Findings and Versions tabs. Tabs stay sticky on phones. */
export function SpecPanel({
  sessionId,
  spec,
  onSpec,
  versions,
  invitations,
}: {
  sessionId: string;
  spec: LiveSpec;
  onSpec: (spec: LiveSpec) => void;
  versions: SpecVersionSummary[];
  invitations: SessionInvitation[];
}): React.JSX.Element {
  const s = t.admin.requirements.workspace.tabs;
  const openFindings = spec.findings.filter((f) => f.status === "open" || f.status === "raised").length;
  return (
    <Tabs
      defaultValue="spec"
      aria-label={t.admin.requirements.workspace.panelLabel}
      className="min-w-0 gap-4"
    >
      <TabsList className="bg-background/95 sticky top-[3.25rem] z-10 w-full backdrop-blur lg:static">
        <TabsTrigger value="spec">{s.spec}</TabsTrigger>
        <TabsTrigger value="findings">
          {s.findings}
          {openFindings > 0 ? (
            <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-[10px] tabular-nums">
              {openFindings}
            </span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger value="versions">
          {s.versions}
          {versions.length > 0 ? (
            <span className="text-muted-foreground text-[10px] tabular-nums">{versions.length}</span>
          ) : null}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="spec">
        <SpecSections sessionId={sessionId} spec={spec} onSpec={onSpec} />
      </TabsContent>
      <TabsContent value="findings">
        <FindingsList sessionId={sessionId} findings={spec.findings} onSpec={onSpec} />
      </TabsContent>
      <TabsContent value="versions">
        <VersionsPanel sessionId={sessionId} initialVersions={versions} initialInvitations={invitations} />
      </TabsContent>
    </Tabs>
  );
}
