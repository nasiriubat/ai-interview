import type { Aggressiveness, FindingType, InterviewTemplate, Path } from "@aidp/shared";
import type { RequirementsSettings } from "../engine/ports.js";

/** The effective issue-detection and MVP-challenge rules for one session (spec 05, ADM-REQ). */
export interface RequirementsPolicy {
  enabled: boolean;
  everyTurns: number;
  aggressiveness: Aggressiveness;
  typesEnabled: FindingType[];
  pushBackOnce: boolean;
  mvpChallenge: "mandatory" | "optional" | "off";
}

/** Template first; settings override the per-path aggressiveness and the MVP challenge mode when not `template`. */
export function resolvePolicy(
  template: InterviewTemplate,
  path: Path | undefined,
  settings?: RequirementsSettings,
): RequirementsPolicy {
  const d = template.issueDetection;
  const producesSpec = template.outputs.includes("spec_field");
  const override =
    path === "nontechnical" ? settings?.aggressivenessNontechnical : settings?.aggressivenessTechnical;
  const aggressiveness = override && override !== "template" ? override : d.aggressiveness;
  const mvpSetting = settings?.mvpChallenge ?? "template";
  const mvpChallenge = !producesSpec
    ? "off"
    : mvpSetting !== "template"
      ? mvpSetting
      : d.mvpChallenge
        ? "optional"
        : "off";
  return {
    enabled: d.enabled && producesSpec,
    everyTurns: d.everyTurns,
    aggressiveness,
    typesEnabled: d.typesEnabled,
    pushBackOnce: d.pushBackOnce,
    mvpChallenge,
  };
}
