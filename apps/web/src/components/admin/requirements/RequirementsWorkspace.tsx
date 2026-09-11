"use client";

import type { Path } from "@aidp/shared";
import * as React from "react";
import { ConversationPane } from "./ConversationPane";
import { SpecPanel } from "./SpecPanel";
import { staffClient } from "@/lib/api/browser";
import { requirementsSessionApi, toParticipantSession } from "@/lib/api/requirements-session";
import type { LiveSpec, RequirementsDetail } from "@/lib/api/schemas";

/**
 * The requirements workspace: the conversation on the left, the live spec on the right.
 * The spec refreshes from the `spec` SSE event after each turn and from the answers of
 * section edits and finding decisions. Reopening reloads the session and remounts the
 * conversation so the hook starts from the fresh transcript.
 */
export function RequirementsWorkspace({ initial }: { initial: RequirementsDetail }): React.JSX.Element {
  const id = initial.session.id;
  const api = React.useMemo(() => requirementsSessionApi(id), [id]);
  const [detail, setDetail] = React.useState(initial);
  const [spec, setSpec] = React.useState<LiveSpec>(initial.spec);
  const [generation, setGeneration] = React.useState(0);

  const setPath = React.useCallback(
    async (path: Path): Promise<void> => {
      await staffClient.requirements.setPath(id, path);
      setSpec((s) => ({ ...s, path }));
    },
    [id],
  );

  const reopen = React.useCallback(async (): Promise<void> => {
    await staffClient.requirements.reopen(id);
    const fresh = await staffClient.requirements.get(id);
    setDetail(fresh);
    setSpec(fresh.spec);
    setGeneration((g) => g + 1);
  }, [id]);

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <ConversationPane
        key={generation}
        api={api}
        initial={toParticipantSession(detail)}
        title={detail.session.title || spec.title}
        onSpec={setSpec}
        onSetPath={setPath}
        onReopen={reopen}
      />
      <SpecPanel
        sessionId={id}
        spec={spec}
        onSpec={setSpec}
        versions={detail.versions}
        invitations={detail.invitations}
      />
    </div>
  );
}
