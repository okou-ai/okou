import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { command } from "ccstate";

import { badRequestMessage,notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
cancelClaudeCodeDeviceAuth$,
claudeCodeDeviceAuthUnavailable,
completeClaudeCodeDeviceAuth$,
startClaudeCodeDeviceAuth$,
} from "../services/claude-code-device-auth.service";

const modelProviderWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startClaudeCodeDeviceAuthBody$ = bodyResultOf(
  claudeCodeDeviceAuthContract.start,
);
const completeClaudeCodeDeviceAuthBody$ = bodyResultOf(
  claudeCodeDeviceAuthContract.complete,
);
const cancelClaudeCodeDeviceAuthBody$ = bodyResultOf(
  claudeCodeDeviceAuthContract.cancel,
);

const startClaudeCodeDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(startClaudeCodeDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (
      body.data.scope === "personal" &&
      body.data.mode === "reconnect" &&
      !body.data.modelProviderId
    ) {
      return badRequestMessage("modelProviderId is required for reconnect");
    }

    const result = await set(
      startClaudeCodeDeviceAuth$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        scope: body.data.scope,
        mode: body.data.mode,
        modelProviderId: body.data.modelProviderId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      return claudeCodeDeviceAuthUnavailable(result.message);
    }

    return {
      status: 200 as const,
      body: {
        sessionToken: result.sessionToken,
        type: "claude-code" as const,
        status: "pending" as const,
        scope: result.scope,
        browserUrl: result.browserUrl,
        expiresIn: result.expiresIn,
      },
    };
  },
);

const completeClaudeCodeDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(completeClaudeCodeDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      completeClaudeCodeDeviceAuth$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        orgRole: auth.orgRole,
        sessionToken: body.data.sessionToken,
        authorizationCode: body.data.authorizationCode,
      },
      signal,
    );
    signal.throwIfAborted();

    switch (result.status) {
      case "complete": {
        return {
          status: 200 as const,
          body: {
            status: "complete" as const,
            provider: result.body.provider,
            created: result.body.created,
          },
        };
      }
      case "invalid_token": {
        return badRequestMessage(result.message);
      }
      case "forbidden": {
        return notFound(result.message);
      }
      case "auth_error": {
        return result.response;
      }
      case "error": {
        return claudeCodeDeviceAuthUnavailable(result.message);
      }
    }
  },
);

const cancelClaudeCodeDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(cancelClaudeCodeDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      cancelClaudeCodeDeviceAuth$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        sessionToken: body.data.sessionToken,
      },
      signal,
    );
    signal.throwIfAborted();

    switch (result.status) {
      case "cancelled": {
        return {
          status: 200 as const,
          body: { status: "cancelled" as const },
        };
      }
      case "invalid_token": {
        return badRequestMessage(result.message);
      }
      case "forbidden": {
        return notFound(result.message);
      }
    }
  },
);

export const claudeCodeDeviceAuthRoutes: readonly RouteEntry[] = [
  {
    route: claudeCodeDeviceAuthContract.start,
    handler: authRoute(modelProviderWriteAuth, startClaudeCodeDeviceAuthInner$),
  },
  {
    route: claudeCodeDeviceAuthContract.complete,
    handler: authRoute(
      modelProviderWriteAuth,
      completeClaudeCodeDeviceAuthInner$,
    ),
  },
  {
    route: claudeCodeDeviceAuthContract.cancel,
    handler: authRoute(
      modelProviderWriteAuth,
      cancelClaudeCodeDeviceAuthInner$,
    ),
  },
];
