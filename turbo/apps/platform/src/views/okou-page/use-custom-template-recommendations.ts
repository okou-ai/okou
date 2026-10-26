import type { UserTemplateKind } from "@okouai/api-contracts/contracts/user-templates";
import { useGet, useLastLoadable } from "ccstate-react";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { projectCustomTemplate$ } from "../../signals/okou-page/custom-template-library.ts";

/** Keep covers during refresh while immediately applying confirmed edits. */
export function useCustomTemplateRecommendations(
  signals: ComposerSignals,
  kind: UserTemplateKind,
) {
  const catalog = useLastLoadable(signals.taskChips.customTemplates$);
  const project = useGet(projectCustomTemplate$);
  if (catalog.state !== "hasData") {
    return [];
  }
  return catalog.data.flatMap((template) => {
    const projected = project(template);
    return projected?.kind === kind ? [projected] : [];
  });
}
