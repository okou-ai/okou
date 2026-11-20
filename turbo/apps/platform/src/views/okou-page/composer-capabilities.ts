import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Route, Shapes, Telescope, UserRoundSearch } from "lucide-react";
import type { HomeCapability } from "../../signals/okou-page/composer-home.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

/** Create's choices and Workflow's kinds, in the order the home and its tray offer them. */
export const CREATE_TASKS = [
  { task: "presentation" },
  { task: "image" },
  { task: "document" },
  { task: "website" },
  { task: "visualization" },
] as const;
export const WORKFLOW_KINDS = [
  { kind: "scheduled" },
  { kind: "triggers" },
  { kind: "advanced" },
] as const;

/** The same capabilities, labels and activation used by the home tray. */
export function useComposerCapabilities(signals: ComposerSignals) {
  const { t } = useTranslation();
  const open = useSet(signals.taskChips.home.openCapability$);
  const focusEditor = useSet(signals.editor.focus$);
  const pageSignal = useGet(pageSignal$);
  const labels = {
    search: t(($) => {
      return $.chat.capabilityHome.search.title;
    }),
    research: t(($) => {
      return $.chat.capabilityHome.research.title;
    }),
    create: t(($) => {
      return $.chat.capabilityHome.create.title;
    }),
  };
  const workflow = t(($) => {
    return $.chat.taskChips.tasks.workflow;
  });
  const activate = async (capability: HomeCapability) => {
    await open(capability, pageSignal);
    focusEditor();
  };
  const run = (capability: HomeCapability) => {
    return () => {
      detach(activate(capability), Reason.DomCallback);
    };
  };
  return [
    {
      id: "search",
      Icon: UserRoundSearch,
      label: labels.search,
      keywords: ["find", "people", "search"],
      run: run("search"),
    },
    {
      id: "research",
      Icon: Telescope,
      label: labels.research,
      keywords: ["research"],
      run: run("research"),
    },
    {
      id: "create",
      Icon: Shapes,
      label: labels.create,
      keywords: ["create"],
      run: run("create"),
    },
    {
      id: "workflow",
      Icon: Route,
      label: workflow,
      keywords: ["workflow"],
      run: run("workflow"),
    },
  ] as const;
}
