import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Route, Shapes, Telescope, UserRoundSearch } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import type { HomeCapability } from "../../signals/okou-page/composer-home.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";

/*
 * Each Create and Workflow choice carries `data-art`; its card shows the
 * matching drawing while that choice is hovered or focused. The visibility
 * classes are spelled out in full because Tailwind's scanner only generates
 * classes that appear literally in the source.
 */
export const CREATE_TASKS = [
  {
    task: "presentation",
    art: "presentation",
    visibility:
      "group-has-[[data-art]:not([data-art=presentation]):is(:hover,:focus-visible)]/card:hidden",
  },
  {
    task: "image",
    art: "image",
    visibility:
      "hidden group-has-[[data-art=image]:is(:hover,:focus-visible)]/card:block",
  },
  {
    task: "document",
    art: "document",
    visibility:
      "hidden group-has-[[data-art=document]:is(:hover,:focus-visible)]/card:block",
  },
  {
    task: "website",
    art: "website",
    visibility:
      "hidden group-has-[[data-art=website]:is(:hover,:focus-visible)]/card:block",
  },
  {
    task: "visualization",
    art: "chart",
    visibility:
      "hidden group-has-[[data-art=chart]:is(:hover,:focus-visible)]/card:block",
  },
] as const;
export const WORKFLOW_KINDS = [
  {
    kind: "scheduled",
    art: "scheduled",
    visibility:
      "hidden group-has-[[data-art=scheduled]:is(:hover,:focus-visible)]/card:block",
  },
  {
    kind: "triggers",
    art: "triggers",
    visibility:
      "hidden group-has-[[data-art=triggers]:is(:hover,:focus-visible)]/card:block",
  },
  {
    kind: "advanced",
    art: "advanced",
    visibility:
      "group-has-[[data-art]:not([data-art=advanced]):is(:hover,:focus-visible)]/card:hidden",
  },
] as const;

/** The same capabilities, labels and activation used by the home tray. */
export function useComposerCapabilities(signals: ComposerSignals) {
  const { t } = useTranslation();
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.HomeCapabilities];
  const open = useSet(signals.taskChips.home.openCapability$);
  const focusEditor = useSet(signals.editor.focus$);
  const copy = t(
    ($) => {
      return $.chat.capabilityHome;
    },
    { returnObjects: true },
  );
  const workflow = t(($) => {
    return $.chat.taskChips.tasks.workflow;
  });
  const run = (capability: HomeCapability) => {
    return () => {
      open(capability);
      focusEditor();
    };
  };
  return enabled
    ? ([
        {
          id: "search",
          Icon: UserRoundSearch,
          label: copy.search.title,
          keywords: ["find", "people", "search"],
          run: run("search"),
        },
        {
          id: "research",
          Icon: Telescope,
          label: copy.research.title,
          keywords: ["research"],
          run: run("research"),
        },
        {
          id: "create",
          Icon: Shapes,
          label: copy.create.title,
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
      ] as const)
    : null;
}
