import { command, computed, state, type State } from "ccstate";
import { createElement } from "react";
import {
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
} from "@okouai/api-contracts/contracts/desktop-auth";
import { accept } from "../../lib/accept.ts";
import { DesktopAuthPage } from "../../views/desktop-auth/desktop-auth-page.tsx";
import { apiClient$ } from "../api-client.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { clerk$, clerkUser$, resolveAppAuthUrl } from "../auth.ts";
import { updatePage$ } from "../react-router.ts";
import { replaceState } from "../location.ts";
import { searchParams$ } from "../route.ts";
import { setLoop, settle } from "../utils.ts";
import {
  callbackScheme,
  completeDesktopSession$,
  continueDesktopTask$,
  desktopAuthUrl,
  handoffParams,
  validateDesktopCallback,
  waitForDesktopIdentity$,
  waitForDesktopOperation,
  type DesktopAuthRoute,
} from "./protocol.ts";

/** One second apart, so the budget matches the callback attempt's deadline. */
const CALLBACK_POLL_LIMIT = 120;

type DesktopAuthPhase =
  | "connecting"
  | "pending"
  | "consumed"
  | "completed"
  | "selecting"
  | "no-workspaces"
  | "failed";

const startDesktopAuth$ = command(
  async ({ get, set }, params: URLSearchParams, signal: AbortSignal) => {
    const callback = desktopAuthUrl(
      "callback",
      new URLSearchParams({ callbackScheme: callbackScheme(params) }),
    );
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (await set(continueDesktopTask$, callback, signal)) {
      return;
    }
    location.replace(
      clerk.session
        ? callback
        : resolveAppAuthUrl("/sign-in", { redirectUrl: callback }),
    );
  },
);

const consumeDesktopAuth$ = command(
  async ({ get, set }, params: URLSearchParams, signal: AbortSignal) => {
    const code = params.get("code");
    // Remove the one-time code without restarting this route or adding history.
    // The ticket returned below never leaves this command's local memory.
    const scrubbedParams = new URLSearchParams(params);
    scrubbedParams.delete("code");
    replaceState(history.state, "", desktopAuthUrl("consume", scrubbedParams));
    const nextParams = handoffParams(params);
    if (!code || !/^[A-Za-z0-9_-]{32,128}$/u.test(code)) {
      throw new Error("Invalid desktop sign-in code");
    }
    const client = get(apiClient$)(desktopAuthConsumeContract, {
      getToken: () => {
        return Promise.resolve(null);
      },
    });
    const response = await accept(
      client.consume({ body: { code }, fetchOptions: { signal } }),
      [200],
      signal,
      { showErrorToast: false },
    );
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.client) {
      throw new Error("Desktop sign-in unavailable");
    }
    const result = await waitForDesktopOperation(
      clerk.client.signIn.create({
        strategy: "ticket",
        ticket: response.body.token,
      }),
      signal,
    );
    signal.throwIfAborted();
    if (result.status !== "complete" || !result.createdSessionId) {
      throw new Error("Desktop session activation incomplete");
    }
    const destination = desktopAuthUrl("token", nextParams);
    let taskDestination: string | undefined;
    await waitForDesktopOperation(
      clerk.setActive({
        session: result.createdSessionId,
        navigate: ({ session, decorateUrl }) => {
          signal.throwIfAborted();
          if (session.currentTask) {
            taskDestination = decorateUrl(
              resolveAppAuthUrl(`/sign-in/tasks/${session.currentTask.key}`, {
                redirectUrl: destination,
              }),
            );
          }
        },
      }),
      signal,
    );
    signal.throwIfAborted();
    if (taskDestination) {
      location.replace(taskDestination);
      return;
    }
    await set(
      waitForDesktopIdentity$,
      result.createdSessionId,
      undefined,
      signal,
    );
    signal.throwIfAborted();
    location.replace(destination);
  },
);

const activateDesktopOrganization$ = command(
  async (
    { get, set },
    organization: string,
    params: URLSearchParams,
    signal: AbortSignal,
  ) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const sessionId = clerk.session?.id;
    if (!sessionId) {
      location.replace(desktopAuthUrl("start"));
      return;
    }
    // Suppress Clerk's immediate task navigation so the Desktop protocol can
    // preserve its handoff before redirecting the required task into hosted
    // auth below. The global organization watcher yields to this protocol.
    await waitForDesktopOperation(
      clerk.setActive({
        organization,
        navigate: () => {
          signal.throwIfAborted();
        },
      }),
      signal,
    );
    signal.throwIfAborted();
    await set(waitForDesktopIdentity$, sessionId, organization, signal);
    if (
      await set(continueDesktopTask$, desktopAuthUrl("token", params), signal)
    ) {
      return;
    }
    await set(completeDesktopSession$, params, signal);
  },
);

function createDesktopMemberships() {
  return computed(async (get) => {
    const user = await get(clerkUser$);
    if (!user) {
      return [];
    }
    // Clerk's page is bounded; fetch every page so workspace choice does not
    // silently omit memberships beyond the first SDK page.
    const memberships = [];
    let offset = 0;
    for (;;) {
      const page = await user.getOrganizationMemberships({
        initialPage: Math.floor(offset / 100) + 1,
        pageSize: 100,
      });
      memberships.push(...page.data);
      offset += page.data.length;
      if (offset >= page.total_count || page.data.length === 0) {
        return memberships;
      }
    }
  });
}

function createDesktopCallback(
  params: URLSearchParams,
  phase$: State<DesktopAuthPhase>,
  callbackUrl$: State<string | null>,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const scheme = callbackScheme(params);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.session || clerk.session.currentTask) {
      await set(startDesktopAuth$, params, signal);
      return;
    }
    const client = get(apiClient$)(desktopAuthHandoffContract);
    const response = await accept(
      client.create({
        body: { callbackScheme: scheme },
        fetchOptions: { signal },
      }),
      [200],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    const handoff = response.body;
    validateDesktopCallback(handoff.callbackUrl, scheme, handoff.handoffId);
    set(callbackUrl$, handoff.callbackUrl);
    set(phase$, "pending");
    location.assign(handoff.callbackUrl);
    // The deadline on the caller's signal only stops the work: `settle`
    // rethrows aborts, so an aborted attempt never reaches the failed phase.
    // Keep a poll budget so the timeout surfaces as an ordinary error the page
    // can turn into the retry prompt.
    let polls = 0;
    await setLoop(
      async (loopSignal) => {
        if (polls++ >= CALLBACK_POLL_LIMIT) {
          throw new Error("Desktop sign-in timed out");
        }
        const status = await accept(
          client.status({
            params: { handoffId: handoff.handoffId },
            fetchOptions: { signal: loopSignal },
          }),
          [200],
          loopSignal,
          { showErrorToast: false },
        );
        loopSignal.throwIfAborted();
        set(phase$, status.body.status);
        if (status.body.status !== "completed") {
          return false;
        }
        set(callbackUrl$, null);
        return true;
      },
      1000,
      signal,
      { retryTransientErrors: false },
    );
  });
}

function createDesktopToken(
  mode: DesktopAuthRoute,
  params: URLSearchParams,
  phase$: State<DesktopAuthPhase>,
  memberships$: ReturnType<typeof createDesktopMemberships>,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const nextParams = handoffParams(params);
    if (params.get("force") === "true") {
      nextParams.set("force", "true");
    }
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.session) {
      // Native uses this document navigation to terminate a hidden refresh.
      location.replace(desktopAuthUrl("start"));
      return;
    }
    if (
      await set(
        continueDesktopTask$,
        desktopAuthUrl("token", nextParams),
        signal,
      )
    ) {
      return;
    }
    if (clerk.organization && params.get("force") !== "true") {
      await set(completeDesktopSession$, nextParams, signal);
      return;
    }
    const memberships = await waitForDesktopOperation(
      get(memberships$),
      signal,
    );
    signal.throwIfAborted();
    if (mode === "token") {
      if (memberships.length === 1 && params.get("force") !== "true") {
        await set(
          activateDesktopOrganization$,
          memberships[0]!.organization.id,
          nextParams,
          signal,
        );
      } else {
        location.replace(desktopAuthUrl("select-org", nextParams));
      }
      return;
    }
    set(phase$, memberships.length ? "selecting" : "no-workspaces");
  });
}

function createDesktopSelection(
  params: URLSearchParams,
  phase$: State<DesktopAuthPhase>,
  memberships$: ReturnType<typeof createDesktopMemberships>,
  selectedOrganization$: State<string | null>,
) {
  return command(
    async ({ get, set }, organizationId: string, signal: AbortSignal) => {
      if (get(phase$) !== "selecting" || get(selectedOrganization$)) {
        return;
      }
      const memberships = await waitForDesktopOperation(
        get(memberships$),
        signal,
      );
      signal.throwIfAborted();
      if (get(selectedOrganization$)) {
        return;
      }
      if (
        !memberships.some(({ organization }) => {
          return organization.id === organizationId;
        })
      ) {
        return;
      }
      set(selectedOrganization$, organizationId);
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
      const result = await settle(
        waitForDesktopOperation(
          set(
            activateDesktopOrganization$,
            organizationId,
            handoffParams(params),
            attempt,
          ),
          attempt,
        ),
        signal,
      );
      if (!result.ok) {
        set(phase$, "failed");
      }
    },
  );
}

function createDesktopAuthSignals(
  mode: DesktopAuthRoute,
  params: URLSearchParams,
) {
  const phase$ = state<DesktopAuthPhase>("connecting");
  const selectedOrganization$ = state<string | null>(null);
  const callbackUrl$ = state<string | null>(null);
  const memberships$ = createDesktopMemberships();

  const callback$ = createDesktopCallback(params, phase$, callbackUrl$);

  const token$ = createDesktopToken(mode, params, phase$, memberships$);

  const run$ = command(async ({ set }, signal: AbortSignal) => {
    switch (mode) {
      case "start": {
        await set(startDesktopAuth$, params, signal);
        break;
      }
      case "callback": {
        await set(callback$, signal);
        break;
      }
      case "consume": {
        await set(consumeDesktopAuth$, params, signal);
        break;
      }
      case "token":
      case "select-org": {
        await set(token$, signal);
        break;
      }
    }
  });

  const initialize$ = command(async ({ set }, signal: AbortSignal) => {
    const attempt = AbortSignal.any([
      signal,
      AbortSignal.timeout(mode === "callback" ? 120_000 : 25_000),
    ]);
    const result = await settle(
      waitForDesktopOperation(set(run$, attempt), attempt),
      signal,
    );
    if (!result.ok) {
      // Deliberately discard API/Clerk errors: their text can contain secrets.
      set(callbackUrl$, null);
      set(phase$, "failed");
    }
  });

  const selectOrganization$ = createDesktopSelection(
    params,
    phase$,
    memberships$,
    selectedOrganization$,
  );

  const reopen$ = command(({ get }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const url = get(callbackUrl$);
    if (url && get(phase$) === "pending") {
      location.assign(url);
    }
  });
  const retry$ = command(({ get }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (mode === "callback" && get(phase$) === "failed") {
      location.replace(desktopAuthUrl("callback", params));
    }
  });
  return {
    phase$,
    selectedOrganization$,
    memberships$,
    initialize$,
    selectOrganization$,
    reopen$,
    retry$,
  };
}

export type DesktopAuthSignals = ReturnType<typeof createDesktopAuthSignals>;

export function setupDesktopAuthPage(mode: DesktopAuthRoute) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const params = new URLSearchParams(get(searchParams$));
    const signals = createDesktopAuthSignals(mode, params);
    // The app root mounts nothing until the Clerk runtime resolves, and the
    // skeleton only stays up while no page is published. Publishing earlier
    // would blank the screen for the length of the Clerk load.
    await get(clerk$);
    signal.throwIfAborted();
    set(updatePage$, createElement(DesktopAuthPage, { signals, mode }));
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
    await set(signals.initialize$, signal);
  });
}
