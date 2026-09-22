import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { WorkflowTemplateItem } from "@okouai/core/workflow-template-items";
import type { WorkflowComposerSignals } from "./tiptap-workflow-composer.ts";

export interface WorkflowRecommendationActions {
  readonly insertTemplate$: WorkflowComposerSignals["insertTemplate$"];
  readonly insertPrompt$: WorkflowComposerSignals["replacePromptText$"];
  readonly openTemplatePicker$: WorkflowComposerSignals["openTemplatePicker$"];
  readonly focusEditor$: WorkflowComposerSignals["focus$"];
  readonly saveDraft$: Command<Promise<void>, [AbortSignal]>;
}

interface WorkflowRecommendationDraft {
  readonly template: {
    readonly id: WorkflowTemplateItem["id"];
    readonly title: string;
  } | null;
  readonly prompt: string;
}

/** The global colour tokens a shelf cover may be mixed from. */
export type WorkflowCoverTone =
  | "artifact-presentation"
  | "chart-green"
  | "chart-orange"
  | "chart-blue-300"
  | "artifact-image"
  | "chart-gold"
  | "usage-kind-image"
  | "usage-kind-connector"
  | "artifact-video";

/** The shape of the thing a workflow leaves behind, sketched under its marks. */
export type WorkflowCoverKind =
  | "doc"
  | "card"
  | "list"
  | "check"
  | "table"
  | "chart";

/**
 * What the shelf cover draws. `sources` are the connectors the workflow reads
 * and `destination` the one it delivers into, the same split the onboarding
 * diagram makes; a workflow that only reads has no destination. `tone` is one
 * of the platform's own colour tokens, chosen so the nine covers spread across
 * the hue circle.
 */
interface WorkflowRecommendationCover {
  readonly tone: WorkflowCoverTone;
  readonly kind: WorkflowCoverKind;
  readonly sources: readonly [ConnectorSlug, ...ConnectorSlug[]];
  readonly destination: ConnectorSlug | null;
}

// Every card's connectors must offer OAuth in the live catalog, the same rule
// the workflow catalog follows. A null templateId means the card contributes
// its prompt without attaching a built-in template: `reply` never had one, and
// the catalog dropped the templates behind `recap`, `competitors`, and
// `metrics` when their work still needed an API-key connector.
export const WORKFLOW_RECOMMENDATIONS = [
  {
    id: "morning",
    templateId: "workflow-template:morning-brief",
    connectors: ["gmail", "google-calendar", "slack"],
    cover: {
      tone: "artifact-presentation",
      kind: "doc",
      sources: ["gmail", "google-calendar"],
      destination: "slack",
    },
  },
  {
    id: "meetings",
    templateId: "workflow-template:research-calendar-meetings",
    connectors: ["google-calendar"],
    cover: {
      tone: "chart-green",
      kind: "card",
      sources: ["google-calendar"],
      destination: null,
    },
  },
  {
    id: "inbox",
    templateId: "workflow-template:sort-gmail-draft-replies",
    connectors: ["gmail"],
    cover: {
      tone: "chart-orange",
      kind: "list",
      sources: ["gmail"],
      destination: null,
    },
  },
  {
    id: "weekly",
    templateId: "workflow-template:personal-weekly-digest",
    connectors: ["slack"],
    cover: {
      tone: "chart-blue-300",
      kind: "check",
      sources: ["slack"],
      destination: null,
    },
  },
  {
    id: "recap",
    templateId: null,
    connectors: ["google-meet"],
    cover: {
      tone: "artifact-image",
      kind: "doc",
      sources: ["google-meet"],
      destination: null,
    },
  },
  {
    id: "invoices",
    templateId: "workflow-template:file-gmail-invoices-drive",
    connectors: ["gmail", "google-drive"],
    cover: {
      tone: "chart-gold",
      kind: "table",
      sources: ["gmail"],
      destination: "google-drive",
    },
  },
  {
    id: "competitors",
    templateId: null,
    connectors: ["notion"],
    cover: {
      tone: "usage-kind-image",
      kind: "doc",
      sources: ["notion"],
      destination: null,
    },
  },
  {
    id: "metrics",
    templateId: null,
    connectors: ["posthog", "slack"],
    cover: {
      tone: "usage-kind-connector",
      kind: "chart",
      sources: ["posthog"],
      destination: "slack",
    },
  },
  {
    id: "reply",
    templateId: null,
    connectors: ["gmail"],
    cover: {
      tone: "artifact-video",
      kind: "list",
      sources: ["gmail"],
      destination: null,
    },
  },
] as const satisfies readonly {
  readonly id: string;
  readonly templateId: WorkflowTemplateItem["id"] | null;
  readonly connectors: readonly ConnectorSlug[];
  readonly cover: WorkflowRecommendationCover;
}[];

export type WorkflowRecommendation = (typeof WORKFLOW_RECOMMENDATIONS)[number];
export type WorkflowRecommendationId = WorkflowRecommendation["id"];

export function createWorkflowRecommendationSignals(
  visible$: Computed<boolean>,
  actions: WorkflowRecommendationActions,
) {
  const internalView$ = state<WorkflowRecommendationId | null>(null);
  const internalContext$ = state("");
  const internalFocusAfterClose$ = state(false);
  const view$ = computed((get) => {
    return get(visible$) ? get(internalView$) : null;
  });
  const context$ = computed((get) => {
    return get(internalContext$);
  });
  const open$ = command(({ get, set }, view: WorkflowRecommendationId) => {
    if (!get(visible$)) {
      return;
    }
    set(internalView$, view);
    set(internalContext$, "");
  });
  const close$ = command(({ set }) => {
    set(internalView$, null);
    set(internalContext$, "");
  });
  const browse$ = command(({ get, set }) => {
    if (!get(visible$)) {
      return;
    }
    set(close$);
    set(actions.openTemplatePicker$, { kind: "insert", category: "workflow" });
  });
  const use$ = command(
    async (
      { get, set },
      draft: WorkflowRecommendationDraft,
      signal: AbortSignal,
    ) => {
      if (get(view$) === null) {
        return;
      }
      if (draft.template) {
        set(
          actions.insertTemplate$,
          {
            type: "workflow",
            selection: { workflowTemplateId: draft.template.id },
          },
          {
            type: "workflow",
            title: draft.template.title,
            category: "workflow",
          },
        );
      }
      set(actions.insertPrompt$, draft.prompt);
      set(internalFocusAfterClose$, true);
      set(close$);
      await set(actions.saveDraft$, signal);
    },
  );
  const completeClose$ = command(({ get, set }, isOpen: boolean) => {
    if (!isOpen && get(internalFocusAfterClose$)) {
      set(internalFocusAfterClose$, false);
      set(actions.focusEditor$);
    }
  });
  const setContext$ = command(({ set }, value: string) => {
    set(internalContext$, value);
  });
  return {
    view$,
    context$,
    open$,
    close$,
    browse$,
    use$,
    completeClose$,
    setContext$,
  };
}
