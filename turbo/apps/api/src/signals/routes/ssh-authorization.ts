import { command } from "ccstate";
import { sshAuthorizationContract as contract } from "@okouai/api-contracts/contracts/ssh-authorization";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { publishUserSignal } from "../external/realtime";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import {
  markSshAuthorizationContinued$,
  createSshAuthorization$,
  decideSshAuthorization$,
  readSshAuthorization$,
} from "../services/ssh-authorization.service";
import { notifyRemoteAccessChange$ } from "../services/chat-remote-access.service";
import { sendNormalEvent$ } from "../services/chat-events.command";
import type { RouteEntry } from "../route-entry";

function error<T extends 403 | 404 | 409 | 410 | 503>(
  status: T,
  code: string,
  message: string,
) {
  return { status, body: { error: { code, message } } };
}
const unavailable = error(404, "NOT_FOUND", "SSH access request not found");
const enabled$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = get(organizationAuthContext$);
  const features = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  return isFeatureEnabled(FeatureSwitchKey.SshChatApproval, features);
});
const createBody$ = bodyResultOf(contract.create);
const params$ = pathParamsOf(contract.get);
const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(enabled$, signal))) {
    return unavailable;
  }
  const auth = get(organizationAuthContext$);
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (auth.tokenType !== "agent") {
    return unavailable;
  }
  const id = await set(
    createSshAuthorization$,
    { ...body.data, orgId: auth.orgId, userId: auth.userId, runId: auth.runId },
    signal,
  );
  if (!id) {
    return error(
      409,
      "CONFLICT",
      "Request access from the current Web Chat Run to an owned, configured SSH host",
    );
  }
  const result = await set(readSshAuthorization$, auth, id, signal);
  return result
    ? { status: 200 as const, body: result.authorization }
    : unavailable;
});
const read$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(enabled$, signal))) {
    return unavailable;
  }
  const result = await set(
    readSshAuthorization$,
    get(organizationAuthContext$),
    get(params$).id,
    signal,
  );
  return result
    ? { status: 200 as const, body: result.authorization }
    : unavailable;
});
type SshContext = NonNullable<
  Awaited<ReturnType<(typeof readSshAuthorization$)["write"]>>
>;
const continueSshAuthorization$ = command(
  async ({ get, set }, current: SshContext, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "session") {
      return unavailable;
    }
    const id = current.row.id;
    if (
      current.authorization.status === "approved" &&
      current.authorization.continuationPending
    ) {
      if (!current.permissionsAllowed) {
        return error(
          409,
          "CONFLICT",
          "Required connector approvals are no longer effective",
        );
      }
      // Ordinary Chat input owns queue admission and durable clientEventId deduplication.
      // Retrying an approved request never re-enables an override revoked in settings.
      const prompt = current.row.callbackPrompt;
      const sent = await set(
        sendNormalEvent$,
        {
          auth,
          orgId: auth.orgId,
          userId: auth.userId,
          body: {
            agentId: current.agentId,
            threadId: current.row.chatThreadId,
            clientEventId: id,
            chatThreadSortEventId: id,
            prompt,
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: prompt }],
            },
          },
        },
        signal,
      );
      if (sent.status >= 400) {
        return error(
          503,
          "CONTINUATION_UNAVAILABLE",
          "SSH access was allowed, but continuation could not be queued. Retry to continue without granting again",
        );
      }
      await set(markSshAuthorizationContinued$, auth, id, signal);
    } else if (current.authorization.status === "approved") {
      await set(markSshAuthorizationContinued$, auth, id, signal);
    }
    return undefined;
  },
);

function actionHandler(action: "approve" | "deny" | "revoke") {
  const body$ = bodyResultOf(contract[action]);
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(enabled$, signal))) {
      return unavailable;
    }
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "session") {
      return unavailable;
    }
    const body = await get(body$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const id = get(params$).id;
    let current = await set(readSshAuthorization$, auth, id, signal);
    if (!current) {
      return unavailable;
    }
    const status = current.authorization.status;
    const terminal =
      action === "approve"
        ? "approved"
        : action === "deny"
          ? "denied"
          : "revoked";
    if (status !== terminal) {
      if (status === "expired") {
        return error(
          410,
          "GONE",
          "SSH access request expired; request access again",
        );
      }
      if (
        status !== (action === "revoke" ? "approved" : "pending") ||
        (action === "approve" &&
          current.authorization.approvalBlockedReason !== null)
      ) {
        return error(
          409,
          "CONFLICT",
          "SSH access request is not ready; review its current state before approving",
        );
      }
      const applied = await set(
        decideSshAuthorization$,
        auth,
        current,
        action,
        signal,
      );
      if (!applied) {
        current = await set(readSshAuthorization$, auth, id, signal);
        if (current?.authorization.status !== terminal) {
          return error(
            409,
            "CONFLICT",
            "SSH access request changed; refresh before retrying",
          );
        }
      }
    }
    await set(
      notifyRemoteAccessChange$,
      { ...auth, connectionId: current.row.connectionId },
      "ssh",
      current.row.chatThreadId,
    );
    signal.throwIfAborted();
    await publishUserSignal([auth.userId], "sshAuthorizationChanged");
    signal.throwIfAborted();
    current = await set(readSshAuthorization$, auth, id, signal);
    if (!current) {
      return unavailable;
    }
    if (action === "approve") {
      const failure = await set(continueSshAuthorization$, current, signal);
      if (failure) {
        return failure;
      }
      current = await set(readSshAuthorization$, auth, id, signal);
    }
    return current
      ? { status: 200 as const, body: current.authorization }
      : unavailable;
  });
}
const human = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;
export const sshAuthorizationRoutes: readonly RouteEntry[] = [
  {
    route: contract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["agent"],
        requiredCapability: "connector:read",
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
