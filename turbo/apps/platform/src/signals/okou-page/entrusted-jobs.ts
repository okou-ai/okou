import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { jobsContract } from "@okouai/api-contracts/client/jobs";
import type { JobInputCreate } from "@okouai/api-contracts/contracts/jobs";
import { userPermissionGrantsContract } from "@okouai/api-contracts/client/user-permission-grants";
import { userPermissionGrantExpiresInSchema } from "@okouai/api-contracts/validators/user-permission-grants";
import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/contracts/user-permission-grants";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { defaultAgentId$ } from "../agent.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { onRef } from "../utils.ts";
import { proactiveJobsPreference$ } from "./settings/proactive-jobs.ts";

export const entrustedJobsEnabled$ = computed(async (get) => {
  if (!get(featureSwitch$)[FeatureSwitchKey.ProactiveAgent]) {
    return false;
  }
  const [current, primary] = await Promise.all([
    get(currentChatAgentId$),
    get(defaultAgentId$),
  ]);
  if (primary === null || primary !== current) {
    return false;
  }
  return (await get(proactiveJobsPreference$)).enabled;
});
const revision$ = state(0);
const filter$ = state<"home" | "history" | "archived">("home");
const cursors$ = state<readonly (string | undefined)[]>([undefined]);
const selectedId$ = state<string | null>(null);
const drafts$ = state<
  Readonly<Record<string, { readonly id: string; readonly text: string }>>
>({});
const authorizationInputs$ = state<Readonly<Record<string, string>>>({});
const savedInputId$ = state<string | null>(null);
const grantDuration$ = state<UserPermissionGrantExpiresIn>("24h");
export const jobGrantDuration$ = computed((get) => {
  return get(grantDuration$);
});
export const jobListFilter$ = computed((get) => {
  return get(filter$);
});
export const selectedJobId$ = computed((get) => {
  return get(selectedId$);
});
export const jobReplyText$ = computed((get) => {
  return get(drafts$)[get(selectedId$) ?? ""]?.text ?? "";
});
export const jobReplySaved$ = computed((get) => {
  return get(savedInputId$) === get(selectedId$) && get(selectedId$) !== null;
});
export const jobHasPreviousPage$ = computed((get) => {
  return get(cursors$).length > 1;
});

export const reloadEntrustedJobs$ = command(({ set }) => {
  set(revision$, (value) => {
    return value + 1;
  });
});
export const homeJobSummaries$ = computed(async (get) => {
  get(revision$);
  if (!(await get(entrustedJobsEnabled$))) {
    return [];
  }
  const result = await accept(
    get(apiClient$)(jobsContract).list({
      query: { filter: "home", limit: 100 },
    }),
    [200],
  );
  return result.body.jobs;
});
export const entrustedJobs$ = computed(async (get) => {
  get(revision$);
  const filter = get(filter$);
  const after = get(cursors$).at(-1);
  if (!(await get(entrustedJobsEnabled$))) {
    return { jobs: [], nextAfter: null };
  }
  const result = await accept(
    get(apiClient$)(jobsContract).list({
      query: { filter, limit: 50, ...(after ? { after } : {}) },
    }),
    [200],
  );
  return result.body;
});
export const selectedJob$ = computed(async (get) => {
  get(revision$);
  const id = get(selectedId$);
  if (id === null) {
    return null;
  }
  const result = await accept(
    get(apiClient$)(jobsContract).get({ params: { id } }),
    [200],
  );
  return result.body;
});
export const selectedJobGrant$ = computed(async (get) => {
  const job = await get(selectedJob$);
  const request = job?.work.authorization;
  if (!request || job?.status !== "waiting_authorization") {
    return null;
  }
  const result = await accept(
    get(apiClient$)(userPermissionGrantsContract).list({
      query: { agentId: request.agentId },
    }),
    [200],
  );
  return (
    result.body.find((grant) => {
      return (
        grant.connectorSlug === request.connector &&
        grant.permission === request.permission &&
        grant.action === "allow" &&
        (grant.expiresAt === null || Date.parse(grant.expiresAt) > now())
      );
    }) ?? null
  );
});
export const selectJob$ = command(({ set }, id: string | null) => {
  set(selectedId$, id);
  set(savedInputId$, null);
});
const jobOpener$ = state<HTMLButtonElement | null>(null);
const jobFilterTab$ = state<HTMLButtonElement | null>(null);
export const bindJobFilterTab$ = command(
  ({ set }, element: HTMLButtonElement | null) => {
    set(jobFilterTab$, element);
  },
);
export const jobReturnFocus$ = computed((get) => {
  const opener = get(jobOpener$);
  const tab = get(jobFilterTab$);
  // Viewed completions and archived Jobs remove their opener from the list.
  return () => {
    return opener?.isConnected ? opener : tab;
  };
});
export const openJobFromCard$ = command(
  ({ set }, id: string, element: HTMLButtonElement) => {
    set(jobOpener$, element);
    set(selectJob$, id);
  },
);

export const selectJobListFilter$ = command(({ set }, value: string) => {
  if (value !== "home" && value !== "history" && value !== "archived") {
    return;
  }
  set(filter$, value);
  set(cursors$, [undefined]);
});
export const nextJobPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const page = await get(entrustedJobs$);
    signal.throwIfAborted();
    const next = page.nextAfter;
    if (next) {
      set(cursors$, (values) => {
        return [...values, next];
      });
    }
  },
);
export const previousJobPage$ = command(({ set }) => {
  set(cursors$, (values) => {
    return values.length > 1 ? values.slice(0, -1) : values;
  });
});
export const setJobReply$ = command(({ get, set }, text: string) => {
  const id = get(selectedId$);
  if (id === null) {
    return;
  }
  const prior = get(drafts$)[id];
  set(drafts$, {
    ...get(drafts$),
    [id]: { id: prior?.text === text ? prior.id : crypto.randomUUID(), text },
  });
  set(savedInputId$, null);
});
export const setJobGrantDuration$ = command(({ set }, value: string | null) => {
  const parsed = userPermissionGrantExpiresInSchema.safeParse(value);
  if (parsed.success) {
    set(grantDuration$, parsed.data);
  }
});
export const submitJobReply$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const job = await get(selectedJob$);
    signal.throwIfAborted();
    if (!job || job.status === "archived") {
      return;
    }
    const draft = get(drafts$)[job.id];
    if (!draft?.text.trim()) {
      return;
    }
    await accept(
      get(apiClient$)(jobsContract).input({
        params: { id: job.id },
        body: { id: draft.id, kind: "reply", text: draft.text },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (
      get(drafts$)[job.id]?.id === draft.id &&
      get(drafts$)[job.id]?.text === draft.text
    ) {
      const updated = { ...get(drafts$) };
      delete updated[job.id];
      set(drafts$, updated);
    }
    set(savedInputId$, job.id);
    set(reloadEntrustedJobs$);
  },
);
export const respondToJobAuthorization$ = command(
  async (
    { get, set },
    outcome: "granted" | "declined",
    signal: AbortSignal,
  ) => {
    const job = await get(selectedJob$);
    signal.throwIfAborted();
    const request = job?.work.authorization;
    if (!job || job.status === "archived" || !request) {
      return;
    }
    const primary = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (primary !== request.agentId) {
      throw new Error(
        "The default Agent changed. The Job needs a current authorization request.",
      );
    }
    const key = `${job.id}/${request.id}/${outcome}`;
    const inputId = get(authorizationInputs$)[key] ?? crypto.randomUUID();
    set(authorizationInputs$, { ...get(authorizationInputs$), [key]: inputId });
    if (outcome === "granted") {
      const current = await accept(
        get(apiClient$)(userPermissionGrantsContract).list({
          query: { agentId: request.agentId },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      const allowed = current.body.some((grant) => {
        return (
          grant.connectorSlug === request.connector &&
          grant.permission === request.permission &&
          grant.action === "allow" &&
          (grant.expiresAt === null || Date.parse(grant.expiresAt) > now())
        );
      });
      if (!allowed) {
        await accept(
          get(apiClient$)(userPermissionGrantsContract).apply({
            body: {
              agentId: request.agentId,
              connectorSlug: request.connector,
              mode: "patch",
              grants: [
                {
                  permission: request.permission,
                  action: "allow",
                  expiresIn: get(jobGrantDuration$),
                },
              ],
            },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();
      }
    }
    const body: JobInputCreate = {
      id: inputId,
      kind: "authorization",
      requestId: request.id,
      outcome,
      text: "",
    };
    await accept(
      get(apiClient$)(jobsContract).input({
        params: { id: job.id },
        body,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(savedInputId$, job.id);
    set(reloadEntrustedJobs$);
  },
);
export const archiveSelectedJob$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const id = get(selectedId$);
    if (id === null) {
      return;
    }
    await accept(
      get(apiClient$)(jobsContract).archive({
        params: { id },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadEntrustedJobs$);
  },
);
const acknowledgeDisplayedResult$ = command(
  async ({ get, set }, element: HTMLElement, signal: AbortSignal) => {
    const id = element.dataset.jobId;
    const resultId = element.dataset.resultId;
    if (!id || !resultId) {
      return;
    }
    await accept(
      get(apiClient$)(jobsContract).viewed({
        params: { id },
        body: { resultId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadEntrustedJobs$);
  },
);
export const bindJobResult$ = onRef(acknowledgeDisplayedResult$);
export const enterEntrustedJobs$ = command(({ set }) => {
  set(selectedId$, null);
  set(filter$, "home");
  set(cursors$, [undefined]);
  set(savedInputId$, null);
  set(reloadEntrustedJobs$);
});
export const subscribeEntrustedJobs$ = command(
  ({ get, set }, signal: AbortSignal) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.ProactiveAgent]) {
      return;
    }
    set(
      setAblyInvalidationLoop$,
      {
        scope: "credential",
        topic: "userJobsChanged",
        invalidations: [reloadEntrustedJobs$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);
