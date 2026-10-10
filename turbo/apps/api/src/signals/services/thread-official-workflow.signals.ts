import { computed, type Computed } from "ccstate";
import { conflict } from "../../lib/error";
import { safeSync, settle } from "../utils";
import { parseCanonicalChatEventRequiredOfficialWorkflowIds } from "./canonical-chat-event-read.service";
import { assertRequiredOfficialWorkflows } from "./official-workflow-observation.service";
import {
  type OfficialWorkflowObservation,
  OfficialWorkflowRunAdmissionError,
} from "./official-workflow-run.service";
import type { ThreadContext } from "./thread-context.signals";
import type { ThreadModelError } from "./thread-model.signals";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

export type PreparedOfficialWorkflow =
  OfficialWorkflowObservation | ThreadModelError | undefined;

function isThreadModelError(value: unknown): value is ThreadModelError {
  return typeof value === "object" && value !== null && "status" in value;
}

function createRequiredOfficialWorkflowIds(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationTarget$: ThreadContext["automationTarget$"],
) {
  return computed(async (get): Promise<readonly string[]> => {
    const event = await get(pickedEvent$);
    if (event?.contextType === "automation") {
      const target = await get(automationTarget$);
      return target && target.automation.officialBlueprintKey !== null
        ? [target.automation.workflowId]
        : [];
    }
    // Queued prompt parsing rejects malformed claims before a run is created.
    const parsed = safeSync(() => {
      return parseCanonicalChatEventRequiredOfficialWorkflowIds(
        event?.requiredOfficialWorkflowIds ?? null,
      );
    });
    return "error" in parsed ? [] : (parsed.ok ?? []);
  });
}

/** Admits the picked event's required Official Workflows for its execution. */
export function createOfficialWorkflowSignals(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
) {
  const requiredOfficialWorkflowIds$ = createRequiredOfficialWorkflowIds(
    pickedEvent$,
    threadContext.automationTarget$,
  );
  const workflowModelError$ = computed(async (get) => {
    const [requestedFramework, modelProvider] = await Promise.all([
      get(threadContext.requestedFramework$),
      get(threadContext.modelRoute$),
    ]);
    if (isThreadModelError(requestedFramework)) {
      return requestedFramework;
    }
    return isThreadModelError(modelProvider) ? modelProvider : null;
  });
  const admittedWorkflowObservation$ = computed(async (get) => {
    if (await get(workflowModelError$)) {
      return undefined;
    }
    const execution = await get(threadContext.executionBootstrap$);
    const [observation, requiredOfficialWorkflowIds] = await Promise.all([
      get(execution.officialWorkflowObservation$),
      get(requiredOfficialWorkflowIds$),
    ]);
    assertRequiredOfficialWorkflows(observation, requiredOfficialWorkflowIds);
    return observation;
  });
  const officialWorkflow$ = computed(
    async (get): Promise<PreparedOfficialWorkflow> => {
      const result = await settle(
        Promise.all([
          get(workflowModelError$),
          get(admittedWorkflowObservation$),
        ]),
      );
      if (!result.ok) {
        if (result.error instanceof OfficialWorkflowRunAdmissionError) {
          return conflict(result.error.message);
        }
        throw result.error;
      }
      const [modelError, observation] = result.value;
      return modelError ?? observation;
    },
  );
  const officialWorkflowFacts$ = computed(async (get) => {
    return await get(
      (await get(threadContext.executionBootstrap$)).officialWorkflows$,
    );
  });
  return { officialWorkflow$, officialWorkflowFacts$ };
}
