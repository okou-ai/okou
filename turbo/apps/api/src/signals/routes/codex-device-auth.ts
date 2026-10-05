import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { command } from "ccstate";

import { badRequestMessage,notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
cancelCodexDeviceAuth$,
codexDeviceAuthUnavailable,
completeCodexDeviceAuth$,
startCodexDeviceAuth$,
} from "../services/codex-device-auth.service";

const modelProviderWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startCodexDeviceAuthBody$ = bodyResultOf(codexDeviceAuthContract.start);
const completeCodexDeviceAuthBody$ = bodyResultOf(
  codexDeviceAuthContract.complete,
);
const cancelCodexDeviceAuthBody$ = bodyResultOf(codexDeviceAuthContract.cancel);

const startCodexDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(startCodexDeviceAuthBody$);
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
      startCodexDeviceAuth$,
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
      return codexDeviceAuthUnavailable(result.message);
    }

    return {
      status: 200 as const,
      body: {
        sessionToken: result.sessionToken,
        type: "codex" as const,
        status: "pending" as const,
        scope: result.scope,
        browserUrl: result.browserUrl,
        verificationCode: result.verificationCode,
        expiresIn: result.expiresIn,
        interval: result.interval,
      },
    };
  },
);

const completeCodexDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(completeCodexDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      completeCodexDeviceAuth$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        orgRole: auth.orgRole,
        sessionToken: body.data.sessionToken,
      },
      signal,
    );
    signal.throwIfAborted();

    switch (result.status) {
      case "pending": {
        return {
          status: 200 as const,
          body: {
            status: "pending" as const,
            errorMessage: result.errorMessage,
          },
        };
      }
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
        return codexDeviceAuthUnavailable(result.message);
      }
    }
  },
);

const cancelCodexDeviceAuthInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(cancelCodexDeviceAuthBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      cancelCodexDeviceAuth$,
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

export const codexDeviceAuthRoutes: readonly RouteEntry[] = [
  {
    route: codexDeviceAuthContract.start,
    handler: authRoute(modelProviderWriteAuth, startCodexDeviceAuthInner$),
  },
  {
    route: codexDeviceAuthContract.complete,
    handler: authRoute(modelProviderWriteAuth, completeCodexDeviceAuthInner$),
  },
  {
    route: codexDeviceAuthContract.cancel,
    handler: authRoute(modelProviderWriteAuth, cancelCodexDeviceAuthInner$),
  },
];
