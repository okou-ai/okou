import { command, computed, state, type Computed } from "ccstate";

import { providerUnavailable } from "../../lib/error";
import { logger } from "../../lib/log";
import { clerkReadUnavailable } from "../external/clerk";
import { settle } from "../utils";
import { waitUntil } from "../context/wait-until";
import {
  isPatToken,
  isSandboxToken,
  verifyCliToken,
  verifySandboxToken,
  verifyOkouToken,
} from "./tokens";
import { clerkSessionAuth$ } from "./clerk-session";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { AgentAuthContext, AuthContext, CliAuth } from "../../types/auth";
import {
  cliTokenRecord,
  getMemberRoleAndUpdateCache$,
  MemberRoleRefreshUnavailableError,
  updateCliTokenLastUsedAt$,
} from "../services/auth.service";
import {
  authorization$,
  cookie$,
  route$,
  setResHeader$,
} from "../context/hono";

const L = logger("AuthContext");

export interface AuthOptions {
  readonly requiredCapability?: Capability;
  readonly acceptAnySandboxCapability?: boolean;
  readonly requireOrganization?: boolean;
  readonly missingOrganizationStatus?: 400 | 401;
}

export type AuthErrorResponse = {
  readonly status: 400 | 401 | 403 | 503;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

type OrganizationAuthContext = AuthContext & { readonly orgId: string };

const innerAuthContext$ = state<AuthContext | null>(null);

export const authContext$: Computed<AuthContext> = computed((get) => {
  const ctx = get(innerAuthContext$);
  if (ctx === null) {
    throw new Error("authContext$ accessed outside an authRoute scope");
  }
  return ctx;
});

export const organizationAuthContext$: Computed<OrganizationAuthContext> =
  computed((get): OrganizationAuthContext => {
    const ctx = get(authContext$);
    if (!ctx.orgId) {
      throw new Error(
        "organizationAuthContext$ accessed without requireOrganization auth",
      );
    }
    return { ...ctx, orgId: ctx.orgId };
  });

export const setAuthContext$ = command(({ set }, ctx: AuthContext): void => {
  set(innerAuthContext$, ctx);
});

const cliAuth$ = command(
  async (
    { get, set },
    cliAuth: CliAuth,
    signal: AbortSignal,
  ): Promise<AuthContext | null> => {
    const resolved = await get(cliTokenRecord(cliAuth));
    signal.throwIfAborted();
    if (!resolved) {
      return null;
    }

    waitUntil(set(updateCliTokenLastUsedAt$, cliAuth.tokenId, signal));

    const membership = await set(
      getMemberRoleAndUpdateCache$,
      resolved.orgId,
      resolved.userId,
      signal,
    );
    // A deleted Clerk identity must not degrade into the user-only context a
    // non-member legitimately receives; returning null reaches the existing
    // 401 result instead.
    if (membership.kind === "identity_not_found") {
      return null;
    }
    if (membership.kind === "not_member") {
      return {
        tokenType: "pat",
        userId: resolved.userId,
      };
    }

    return {
      tokenType: "pat",
      userId: resolved.userId,
      orgId: resolved.orgId,
      orgRole: membership.role,
    };
  },
);

function resolveSandboxAuth(
  token: string,
  options: AuthOptions,
): AuthContext | null {
  const sandboxAuth = verifySandboxToken(token);
  if (!sandboxAuth) {
    return null;
  }

  if (options.acceptAnySandboxCapability) {
    return {
      tokenType: "sandbox",
      userId: sandboxAuth.userId,
      orgId: sandboxAuth.orgId,
      runId: sandboxAuth.runId,
    };
  }

  return null;
}

const agentAuth$ = command(
  async (
    { set },
    token: string,
    options: AuthOptions,
    signal: AbortSignal,
  ): Promise<AuthContext | null> => {
    const agentAuth = verifyOkouToken(token);
    if (!agentAuth) {
      return null;
    }

    if (!options.acceptAnySandboxCapability) {
      if (!options.requiredCapability) {
        return null;
      }
      const hasCapability = agentAuth.capabilities.some((capability) => {
        return capability === options.requiredCapability;
      });
      if (!hasCapability) {
        return null;
      }
    }

    const result: AgentAuthContext = {
      tokenType: "agent",
      userId: agentAuth.userId,
      orgId: agentAuth.orgId,
      runId: agentAuth.runId,
      capabilities: [...agentAuth.capabilities],
      ...(agentAuth.computerUseHostId
        ? { computerUseHostId: agentAuth.computerUseHostId }
        : {}),
      ...(agentAuth.customConnectorSourceIds
        ? { customConnectorSourceIds: agentAuth.customConnectorSourceIds }
        : {}),
    };

    const membership = await set(
      getMemberRoleAndUpdateCache$,
      agentAuth.orgId,
      agentAuth.userId,
      signal,
    );
    if (membership.kind === "identity_not_found") {
      return null;
    }
    if (membership.kind === "not_member") {
      return {
        tokenType: "agent" as const,
        userId: result.userId,
        runId: result.runId,
      };
    }

    return { ...result, orgRole: membership.role };
  },
);

const sandboxTokenAuth$ = command(
  async (
    { set },
    token: string,
    options: AuthOptions,
    signal: AbortSignal,
  ): Promise<AuthContext | null> => {
    const agentResult = await set(agentAuth$, token, options, signal);
    if (agentResult) {
      return agentResult;
    }

    if (!options.requiredCapability && !options.acceptAnySandboxCapability) {
      return null;
    }

    const sandboxAuth = resolveSandboxAuth(token, options);
    if (sandboxAuth) {
      return sandboxAuth;
    }

    return null;
  },
);

const resolvedAuthContext$ = command(
  async (
    { get, set },
    options: AuthOptions,
    signal: AbortSignal,
  ): Promise<AuthContext | null> => {
    const authHeader = get(authorization$);

    if (!authHeader?.startsWith("Bearer ")) {
      if (!get(cookie$)) {
        return null;
      }
      return await get(clerkSessionAuth$);
    }

    const token = authHeader.substring(7);

    if (isPatToken(token)) {
      const cliAuth = verifyCliToken(token);
      if (cliAuth) {
        const result = await set(cliAuth$, cliAuth, signal);
        if (result) {
          return result;
        }
      }
      return null;
    }

    if (isSandboxToken(token)) {
      const result = await set(sandboxTokenAuth$, token, options, signal);
      if (result) {
        return result;
      }
      return null;
    }

    return await get(clerkSessionAuth$);
  },
);

function missingCapabilityError(capability: Capability): AuthErrorResponse {
  const message =
    capability === "computer-use:write"
      ? "Computer Use is not authorized for this run. Authorize a computer once in the conversation, then retry."
      : `Missing required capability: ${capability}`;
  return {
    status: 403,
    body: {
      error: {
        message,
        code: "FORBIDDEN",
      },
    },
  };
}

function missingOrganizationError(status: 400 | 401): AuthErrorResponse {
  if (status === 401) {
    return {
      status: 401,
      body: {
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      },
    };
  }

  return {
    status: 400,
    body: {
      error: {
        message: "Explicit org context required — ensure active org in session",
        code: "BAD_REQUEST",
      },
    },
  };
}

function sandboxTokenAuthError(
  token: string,
  options: AuthOptions,
): AuthErrorResponse | null {
  if (!isSandboxToken(token)) {
    return null;
  }

  const sandboxAuth = verifySandboxToken(token);
  const agentAuth = sandboxAuth ? null : verifyOkouToken(token);
  if (!sandboxAuth && !agentAuth) {
    return null;
  }

  if (options.requiredCapability) {
    return missingCapabilityError(options.requiredCapability);
  }

  return {
    status: 403,
    body: {
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    },
  };
}

export const requiredAuthContext$ = command(
  async (
    { get, set },
    options: AuthOptions,
    signal: AbortSignal,
  ): Promise<AuthContext | AuthErrorResponse> => {
    const authHeader = get(authorization$);
    const resolved = await settle(
      set(resolvedAuthContext$, options, signal),
      signal,
    );
    if (!resolved.ok) {
      if (resolved.error instanceof MemberRoleRefreshUnavailableError) {
        L.error("Membership refresh unavailable during authentication", {
          type: "membership_refresh_unavailable",
          reason: resolved.error.reason,
        });
        set(setResHeader$, "Cache-Control", "no-store");
        return providerUnavailable(
          "Authentication refresh is temporarily unavailable",
        );
      }
      // Among Clerk failures, only an exhausted read is mapped here. The
      // negated allowlist keeps all other errors on their existing path.
      const unavailable = clerkReadUnavailable(resolved.error);
      if (!unavailable) {
        throw resolved.error;
      }

      // An exhausted provider retry stays an actionable error-level record.
      const route = get(route$);
      L.error("Clerk read unavailable during authentication", {
        type: "provider_unavailable",
        provider: "clerk",
        provider_status: unavailable.providerStatus,
        failure_class: unavailable.failureClass,
        method: route.method,
        route: route.path,
      });
      set(setResHeader$, "Cache-Control", "no-store");
      return providerUnavailable(
        "Authentication provider is temporarily unavailable",
      );
    }

    const authContext = resolved.value;
    if (authContext) {
      if (options.requireOrganization && !authContext.orgId) {
        return missingOrganizationError(
          options.missingOrganizationStatus ?? 400,
        );
      }
      return authContext;
    }

    if (authHeader?.startsWith("Bearer ")) {
      const error = sandboxTokenAuthError(authHeader.substring(7), options);
      if (error) {
        return error;
      }
    }

    return {
      status: 401 as const,
      body: {
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      },
    };
  },
);
