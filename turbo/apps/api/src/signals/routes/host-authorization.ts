import { command } from "ccstate";
import type {
  sshAuthorizationContract,
  SshAuthorization,
} from "@okouai/api-contracts/contracts/ssh-authorization";
import type { vncAuthorizationContract } from "@okouai/api-contracts/contracts/vnc-authorization";
import {
  readHostAuthorization$,
  createHostAuthorization$,
  decideHostAuthorization$,
  markHostAuthorizationContinued$,
} from "../services/host-authorization.service";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { publishUserSignal } from "../external/realtime";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
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
type Protocol = "ssh" | "vnc";
type Contract =
  typeof sshAuthorizationContract | typeof vncAuthorizationContract;
function unavailable(protocol: Protocol) {
  return error(
    404,
    "NOT_FOUND",
    `${protocol.toUpperCase()} access request not found`,
  );
}
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
function createAuthorizationHandler(protocol: Protocol, contract: Contract) {
  const body$ = bodyResultOf(contract.create);
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(enabled$, signal))) {
      return unavailable(protocol);
    }
    const auth = get(organizationAuthContext$);
    const body = await get(body$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (auth.tokenType !== "agent") {
      return unavailable(protocol);
    }
    const id = await set(
      createHostAuthorization$,
      protocol,
      {
        ...body.data,
        orgId: auth.orgId,
        userId: auth.userId,
        runId: auth.runId,
      },
      signal,
    );
    if (!id) {
      return error(
        409,
        "CONFLICT",
        `Request access from the current Web Chat Run to an owned, configured ${protocol.toUpperCase()} host`,
      );
    }
    const result = await set(
      readHostAuthorization$,
      protocol,
      auth,
      id,
      signal,
    );
    return result
      ? { status: 200 as const, body: result.authorization }
      : unavailable(protocol);
  });
}
function readAuthorizationHandler(protocol: Protocol, contract: Contract) {
  const params$ = pathParamsOf(contract.get);
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(enabled$, signal))) {
      return unavailable(protocol);
    }
    const result = await set(
      readHostAuthorization$,
      protocol,
      get(organizationAuthContext$),
      get(params$).id,
      signal,
    );
    return result
      ? { status: 200 as const, body: result.authorization }
      : unavailable(protocol);
  });
}
type HostContext = NonNullable<
  Awaited<ReturnType<(typeof readHostAuthorization$)["write"]>>
>;
const continueAuthorization$ = command(
  async (
    { get, set },
    protocol: Protocol,
    current: HostContext,
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "session") {
      return unavailable(protocol);
    }
    const id = current.row.id;
    if (
      current.authorization.status === "approved" &&
      current.authorization.continuationPending
    ) {
      if (!current.permissionsAllowed || !current.dependenciesAllowed) {
        return error(
          409,
          "CONFLICT",
          "Required host or connector approvals are no longer effective",
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
          `${protocol.toUpperCase()} access was allowed, but continuation could not be queued. Retry to continue without granting again`,
        );
      }
      await set(markHostAuthorizationContinued$, protocol, auth, id, signal);
    } else if (current.authorization.status === "approved") {
      await set(markHostAuthorizationContinued$, protocol, auth, id, signal);
    }
    return undefined;
  },
);

function invalidDecision(
  action: "approve" | "deny" | "revoke",
  authorization: Pick<SshAuthorization, "status" | "approvalBlockedReason">,
) {
  if (authorization.status === "expired") {
    return error(
      410,
      "GONE",
      "Host access request expired; request access again",
    );
  }
  if (
    authorization.status !== (action === "revoke" ? "approved" : "pending") ||
    (action === "approve" && authorization.approvalBlockedReason !== null)
  ) {
    return error(
      409,
      "CONFLICT",
      "Host access request is not ready; review its current state before approving",
    );
  }
  return undefined;
}
function actionHandler(
  protocol: Protocol,
  contract: Contract,
  action: "approve" | "deny" | "revoke",
) {
  const params$ = pathParamsOf(contract.get);
  const body$ = bodyResultOf(contract[action]);
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(enabled$, signal))) {
      return unavailable(protocol);
    }
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "session") {
      return unavailable(protocol);
    }
    const body = await get(body$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const id = get(params$).id;
    let current = await set(readHostAuthorization$, protocol, auth, id, signal);
    if (!current) {
      return unavailable(protocol);
    }
    const status = current.authorization.status;
    const terminal =
      action === "approve"
        ? "approved"
        : action === "deny"
          ? "denied"
          : "revoked";
    if (status !== terminal) {
      const invalid = invalidDecision(action, current.authorization);
      if (invalid) {
        return invalid;
      }
      const applied = await set(
        decideHostAuthorization$,
        auth,
        current,
        action,
        signal,
      );
      if (!applied) {
        current = await set(readHostAuthorization$, protocol, auth, id, signal);
        if (current?.authorization.status !== terminal) {
          return error(
            409,
            "CONFLICT",
            `${protocol.toUpperCase()} access request changed; refresh before retrying`,
          );
        }
      }
    }
    await set(
      notifyRemoteAccessChange$,
      { ...auth, connectionId: current.row.connectionId },
      protocol,
      current.row.chatThreadId,
    );
    signal.throwIfAborted();
    await publishUserSignal(
      [auth.userId],
      protocol === "ssh"
        ? "sshAuthorizationChanged"
        : "vncAuthorizationChanged",
    );
    signal.throwIfAborted();
    current = await set(readHostAuthorization$, protocol, auth, id, signal);
    if (!current) {
      return unavailable(protocol);
    }
    if (action === "approve") {
      const failure = await set(
        continueAuthorization$,
        protocol,
        current,
        signal,
      );
      if (failure) {
        return failure;
      }
      current = await set(readHostAuthorization$, protocol, auth, id, signal);
    }
    return current
      ? { status: 200 as const, body: current.authorization }
      : unavailable(protocol);
  });
}
const human = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;
export function createHostAuthorizationRoutes(
  protocol: Protocol,
  contract: Contract,
): readonly RouteEntry[] {
  return [
    {
      route: contract.create,
      handler: authRoute(
        {
          requireOrganization: true,
          missingOrganizationStatus: 401,
          accept: ["agent"],
          requiredCapability: "connector:read",
        },
        createAuthorizationHandler(protocol, contract),
      ),
    },
    {
      route: contract.get,
      handler: authRoute(human, readAuthorizationHandler(protocol, contract)),
    },
    {
      route: contract.approve,
      handler: authRoute(human, actionHandler(protocol, contract, "approve")),
    },
    {
      route: contract.deny,
      handler: authRoute(human, actionHandler(protocol, contract, "deny")),
    },
    {
      route: contract.revoke,
      handler: authRoute(human, actionHandler(protocol, contract, "revoke")),
    },
  ];
}
