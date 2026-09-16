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

// A null templateId means the card contributes its prompt without attaching a
// built-in template: the workflow catalog only carries templates whose
// connectors all support OAuth, so recommendations built on API-key-only
// services keep their prompt and drop the attachment.
export const WORKFLOW_RECOMMENDATIONS = [
  {
    id: "morning",
    templateId: "workflow-template:morning-brief",
    connectors: ["gmail", "google-calendar", "slack"],
  },
  {
    id: "meetings",
    templateId: "workflow-template:research-calendar-meetings",
    connectors: ["google-calendar"],
  },
  {
    id: "inbox",
    templateId: "workflow-template:sort-gmail-draft-replies",
    connectors: ["gmail"],
  },
  {
    id: "weekly",
    templateId: "workflow-template:personal-weekly-digest",
    connectors: ["slack"],
  },
  {
    id: "recap",
    templateId: null,
    connectors: ["fireflies"],
  },
  {
    id: "invoices",
    templateId: "workflow-template:file-gmail-invoices-drive",
    connectors: ["gmail", "google-drive"],
  },
  {
    id: "competitors",
    templateId: null,
    connectors: ["firecrawl", "notion"],
  },
  {
    id: "metrics",
    templateId: null,
    connectors: ["plausible", "slack"],
  },
  { id: "reply", templateId: null, connectors: ["gmail"] },
] as const satisfies readonly {
  readonly id: string;
  readonly templateId: WorkflowTemplateItem["id"] | null;
  readonly connectors: readonly ConnectorSlug[];
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
