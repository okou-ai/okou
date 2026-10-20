import { command } from "ccstate";
import {
  desktopShellAuthorizationContract as contract,
  type DesktopShellAuthorization,
} from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import {
  publishThreadListChanged,
  publishChatThreadMessageCreatedSafely,
  publishUserSignal,
} from "../external/realtime";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import {
  createDesktopShellAuthorization$,
  readDesktopShellAuthorization$,
  approveDesktopShellAuthorization$,
  retireDesktopShellAuthorization$,
} from "../services/desktop-shell-authorization.service";
import { pickEnqueuedChatThread$ } from "../services/chat-thread-queue-drain.service";
import { touchSentChatThreadSort$ } from "../services/chat-event-shared.service";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";

function error<T extends 400 | 403 | 404 | 409 | 410>(
  status: T,
  code: string,
  message: string,
) {
  return { status, body: { error: { code, message } } };
}

const shellEnabled$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const context = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  return isFeatureEnabled(FeatureSwitchKey.DesktopShell, context);
});
const disabled = error(403, "FORBIDDEN", "Desktop Shell is disabled");
const unavailable = error(404, "NOT_FOUND", "Shell authorization not found");
const createBody$ = bodyResultOf(contract.create);
const params$ = pathParamsOf(contract.get);

const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(shellEnabled$, signal))) {
    return disabled;
  }
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (auth.tokenType !== "agent" || !auth.computerUseHostId) {
    return error(
      403,
      "SHELL_CONTEXT_UNSUPPORTED",
      "Select a computer for this chat before starting a new Run",
    );
  }
  const id = await set(
    createDesktopShellAuthorization$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId: auth.runId,
      computerUseHostId: auth.computerUseHostId,
      reason: body.data.reason,
    },
    signal,
  );
  if (!id) {
    return error(
      409,
      "CONFLICT",
      "Shell access requests require the current Web Chat and selected computer; refresh and retry",
    );
  }
  const result = await set(readDesktopShellAuthorization$, auth, id, signal);
  if (!result) {
    return unavailable;
  }
  await publishUserSignal([auth.userId], "desktopShellAuthorizationChanged");
  signal.throwIfAborted();
  return { status: 200 as const, body: result.authorization };
});

const read$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(shellEnabled$, signal))) {
    return disabled;
  }
  const result = await set(
    readDesktopShellAuthorization$,
    get(organizationAuthContext$),
    get(params$).id,
    signal,
  );
  return result
    ? { status: 200 as const, body: result.authorization }
    : unavailable;
});

const retireAction$ = command(
  async (
    { set },
    owner: { readonly orgId: string; readonly userId: string },
    state: DesktopShellAuthorization,
    action: "deny" | "revoke",
    signal: AbortSignal,
  ) => {
    const expected = action === "deny" ? "pending" : "approved";
    const terminal = action === "deny" ? "denied" : "revoked";
    if (
      state.status !== expected &&
      state.status !== terminal &&
      state.status !== "expired"
    ) {
      return error(
        409,
        "CONFLICT",
        "This Shell authorization cannot perform that action",
      );
    }
    const applied = await set(
      retireDesktopShellAuthorization$,
      owner,
      state.id,
      action,
      signal,
    );
    if (!applied && state.status === expected) {
      const latest = await set(
        readDesktopShellAuthorization$,
        owner,
        state.id,
        signal,
      );
      if (
        latest?.authorization.status !== terminal &&
        latest?.authorization.status !== "expired"
      ) {
        return error(
          409,
          "CONFLICT",
          "Shell authorization changed; refresh before retrying",
        );
      }
    }
    return undefined;
  },
);

function actionHandler(action: "approve" | "deny" | "revoke") {
  const body$ = bodyResultOf(contract[action]);
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(shellEnabled$, signal))) {
      return disabled;
    }
    const body = await get(body$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const id = get(params$).id;
    const current = await set(readDesktopShellAuthorization$, auth, id, signal);
    if (!current) {
      return unavailable;
    }
    const state = current.authorization;
    if (action === "approve" && state.status !== "approved") {
      if (state.status === "expired") {
        return error(410, "GONE", "Shell authorization request expired");
      }
      if (state.status !== "pending" || state.approvalBlockedReason !== null) {
        return error(
          409,
          "CONFLICT",
          "Wait for this chat's Run to end and keep the requested computer selected before approving",
        );
      }
      const applied = await set(
        approveDesktopShellAuthorization$,
        auth,
        current,
        signal,
      );
      if (applied.status === "model_unavailable") {
        return error(400, "BAD_REQUEST", applied.message);
      }
      if (applied.status !== "approved") {
        return error(
          409,
          "CONFLICT",
          "Shell authorization changed; refresh before retrying",
        );
      }
      waitUntil(
        set(
          pickEnqueuedChatThread$,
          { orgId: auth.orgId, chatThreadId: state.chatThreadId },
          signal,
        ),
      );
      await set(
        touchSentChatThreadSort$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          threadId: state.chatThreadId,
          agentId: current.thread.agentId,
          eventId: state.id,
          touchedAt: nowDate(),
        },
        signal,
      );
      await publishChatThreadMessageCreatedSafely({
        userId: auth.userId,
        orgId: auth.orgId,
        threadId: state.chatThreadId,
      });
      signal.throwIfAborted();
      await publishThreadListChanged(auth);
      signal.throwIfAborted();
    } else if (action !== "approve") {
      const failure = await set(retireAction$, auth, state, action, signal);
      if (failure) {
        return failure;
      }
    }
    await publishUserSignal([auth.userId], "desktopShellAuthorizationChanged");
    signal.throwIfAborted();
    const result = await set(readDesktopShellAuthorization$, auth, id, signal);
    return result
      ? { status: 200 as const, body: result.authorization }
      : unavailable;
  });
}

const human = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;
export const desktopShellAuthorizationRoutes: readonly RouteEntry[] = [
  {
    route: contract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["agent"],
        requiredCapability: "computer-use:shell:write",
      },
      create$,
    ),
  },
  { route: contract.get, handler: authRoute(human, read$) },
  {
    route: contract.approve,
    handler: authRoute(human, actionHandler("approve")),
  },
  { route: contract.deny, handler: authRoute(human, actionHandler("deny")) },
  {
    route: contract.revoke,
    handler: authRoute(human, actionHandler("revoke")),
  },
];
