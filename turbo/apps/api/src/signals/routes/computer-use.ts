import { desktopShellContract } from "@okouai/api-contracts/contracts/desktop-shell";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { command, computed } from "ccstate";
import {
  computerUseAuditEventsContract,
  computerUseCommandContract,
  computerUseHostsContract,
  computerUseWriteCommandContract,
} from "@okouai/api-contracts/contracts/computer-use";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import {
  createComputerUseCommand$,
  getComputerUseCommand$,
  getComputerUseCommandScreenshot$,
  computerUseAuditEvents,
  listComputerUseHosts$,
} from "../services/computer-use.service";
import { computerUseSessionHostRoutes } from "./computer-use-session-hosts";
import { createComputerUseResultSubscription } from "../external/realtime";
import type { RouteEntry } from "../route-entry";

const computerUseHostNotAuthorized = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Computer-use host is not authorized for this run",
      code: "FORBIDDEN",
    }),
  }),
});

function notFound(message: string) {
  return {
    status: 404 as const,
    body: { error: { message, code: "NOT_FOUND" } },
  };
}

function conflict(message: string) {
  return {
    status: 409 as const,
    body: { error: { message, code: "CONFLICT" } },
  };
}

const hostsListInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const boundHostId =
    auth.tokenType === "agent" ? (auth.computerUseHostId ?? null) : undefined;
  if (boundHostId === null) {
    return computerUseHostNotAuthorized;
  }
  const listed = await set(
    listComputerUseHosts$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();
  const body =
    boundHostId === undefined
      ? listed
      : {
          hosts: listed.hosts.filter((host) => {
            return host.id === boundHostId;
          }),
        };
  return { status: 200 as const, body };
});

const commandCreateBody$ = bodyResultOf(computerUseCommandContract.create);
const commandCreateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(commandCreateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const targetHostId =
      auth.tokenType === "agent" ? auth.computerUseHostId : undefined;
    if (auth.tokenType === "agent" && !targetHostId) {
      return computerUseHostNotAuthorized;
    }

    const result = await set(
      createComputerUseCommand$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        kind: bodyResult.data.kind,
        payload: bodyResult.data,
        timeoutMs: bodyResult.data.timeoutMs,
        ...(auth.tokenType === "agent"
          ? { runId: auth.runId, targetHostId }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "no_host") {
      return notFound("No linked computer-use host found");
    }
    if (result.status === "host_ambiguous") {
      return conflict("Multiple active computer-use hosts are online");
    }
    if (result.status === "host_offline") {
      return conflict("No online computer-use host found");
    }
    if (result.status === "host_unsupported") {
      return conflict("No online computer-use host supports this command");
    }

    if (result.status === "shell_authorization_required") {
      return shellAuthorizationRequired;
    }
    const realtime = bodyResult.data.realtime
      ? await createComputerUseResultSubscription(
          {
            userId: auth.userId,
            orgId: auth.orgId,
            commandId: result.commandId,
            timeoutMs: bodyResult.data.timeoutMs,
          },
          signal,
        )
      : undefined;
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        commandId: result.commandId,
        status: result.commandStatus,
        ...(realtime ? { realtime } : {}),
      },
    };
  },
);

const writeCommandCreateBody$ = bodyResultOf(
  computerUseWriteCommandContract.create,
);
const writeCommandCreateInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(writeCommandCreateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const targetHostId =
      auth.tokenType === "agent" ? auth.computerUseHostId : undefined;
    if (auth.tokenType === "agent" && !targetHostId) {
      return computerUseHostNotAuthorized;
    }

    const result = await set(
      createComputerUseCommand$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        kind: bodyResult.data.kind,
        payload: bodyResult.data,
        timeoutMs: bodyResult.data.timeoutMs,
        ...(auth.tokenType === "agent"
          ? { runId: auth.runId, targetHostId }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "no_host") {
      return notFound("No linked computer-use host found");
    }
    if (result.status === "host_ambiguous") {
      return conflict("Multiple active computer-use hosts are online");
    }
    if (result.status === "host_offline") {
      return conflict("No online computer-use host found");
    }
    if (result.status === "host_unsupported") {
      return conflict("No online computer-use host supports this command");
    }

    if (result.status === "shell_authorization_required") {
      return shellAuthorizationRequired;
    }
    const realtime = bodyResult.data.realtime
      ? await createComputerUseResultSubscription(
          {
            userId: auth.userId,
            orgId: auth.orgId,
            commandId: result.commandId,
            timeoutMs: bodyResult.data.timeoutMs,
          },
          signal,
        )
      : undefined;
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        commandId: result.commandId,
        status: result.commandStatus,
        ...(realtime ? { realtime } : {}),
      },
    };
  },
);

const shellAuthorizationRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      code: "SHELL_AUTHORIZATION_REQUIRED",
      message:
        "Shell access requires one-hour approval in this chat. Run okou computer-use shell request-access --reason '<purpose>', share the authorization link, and end this Run.",
    }),
  }),
});

const shellCreateBody$ = bodyResultOf(desktopShellContract.create);
const shellCreateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const parsed = await get(shellCreateBody$);
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const context = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  if (!isFeatureEnabled(FeatureSwitchKey.DesktopShell, context)) {
    return {
      status: 403 as const,
      body: {
        error: { code: "FORBIDDEN", message: "Desktop Shell is disabled" },
      },
    };
  }
  const targetHostId =
    auth.tokenType === "agent" ? auth.computerUseHostId : undefined;
  if (auth.tokenType === "agent" && !targetHostId) {
    return computerUseHostNotAuthorized;
  }
  if (auth.tokenType !== "agent") {
    return {
      status: 403 as const,
      body: {
        error: {
          code: "SHELL_CONTEXT_UNSUPPORTED",
          message:
            "Shell dispatch requires an authorized chat Run; direct session and personal tokens cannot bypass chat consent.",
        },
      },
    };
  }
  const body = parsed.data;
  // The command queue owns only this bounded observation, never the PTY lifetime.
  const timeoutMs = body.waitMs + 15_000;
  const result = await set(
    createComputerUseCommand$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      kind: body.kind,
      payload: body,
      timeoutMs,
      ...(auth.tokenType === "agent"
        ? { runId: auth.runId, targetHostId }
        : {}),
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.status === "no_host") {
    return notFound("No linked computer-use host found");
  }
  if (result.status === "host_ambiguous") {
    return conflict(
      "Multiple computers are online; authorize the intended computer for this run",
    );
  }
  if (result.status === "host_offline") {
    return conflict("The authorized computer is offline");
  }
  if (result.status === "host_unsupported") {
    return conflict(
      "Enable Shell Access in Developer Tools on an updated Desktop",
    );
  }
  if (result.status === "shell_authorization_required") {
    return shellAuthorizationRequired;
  }
  const realtime = body.realtime
    ? await createComputerUseResultSubscription(
        {
          userId: auth.userId,
          orgId: auth.orgId,
          commandId: result.commandId,
          timeoutMs,
        },
        signal,
      )
    : undefined;
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      commandId: result.commandId,
      status: result.commandStatus,
      ...(realtime ? { realtime } : {}),
    },
  };
});

const commandGetParams$ = pathParamsOf(computerUseCommandContract.get);
const commandGetInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(commandGetParams$);
  const hostId =
    auth.tokenType === "agent" ? auth.computerUseHostId : undefined;
  if (auth.tokenType === "agent" && !hostId) {
    return computerUseHostNotAuthorized;
  }
  const result = await set(
    getComputerUseCommand$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      commandId: params.commandId,
      ...(hostId ? { hostId } : {}),
    },
    signal,
  );
  signal.throwIfAborted();

  if (!result) {
    return notFound("Computer-use command not found");
  }
  return { status: 200 as const, body: result };
});

const screenshotGetParams$ = pathParamsOf(
  computerUseCommandContract.getScreenshot,
);
const screenshotGetInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(screenshotGetParams$);
    const hostId =
      auth.tokenType === "agent" ? auth.computerUseHostId : undefined;
    if (auth.tokenType === "agent" && !hostId) {
      return computerUseHostNotAuthorized;
    }
    const screenshot = await set(
      getComputerUseCommandScreenshot$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        commandId: params.commandId,
        ...(hostId ? { hostId } : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    if (!screenshot) {
      return notFound("Computer-use command screenshot not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", screenshot.contentType);
    headers.set("Content-Length", String(screenshot.buffer.length));
    headers.set("Cache-Control", "private, no-store");
    return new Response(new Uint8Array(screenshot.buffer), {
      status: 200,
      headers,
    });
  },
);

const auditEventsQuery$ = queryOf(computerUseAuditEventsContract.list);
const auditEventsScope$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const query = get(auditEventsQuery$);
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    limit: query.limit,
    ...(query.commandId ? { commandId: query.commandId } : {}),
    ...(query.hostId ? { hostId: query.hostId } : {}),
    ...(query.runId ? { runId: query.runId } : {}),
  };
});
const auditEvents$ = computerUseAuditEvents(auditEventsScope$);
const auditEventsListInner$ = command(async ({ get }, signal: AbortSignal) => {
  const body = await get(auditEvents$);
  signal.throwIfAborted();
  return { status: 200 as const, body };
});

const computerUseAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const computerUseCommandAuthOptions = {
  ...computerUseAuthOptions,
  requiredCapability: "computer-use:write",
} as const;

const computerUseHostListAuthOptions = {
  ...computerUseAuthOptions,
  requiredCapability: "computer-use:write",
} as const;

export const computerUseRoutes: readonly RouteEntry[] = [
  ...computerUseSessionHostRoutes,
  {
    route: desktopShellContract.create,
    handler: authRoute(
      {
        ...computerUseAuthOptions,
        requiredCapability: "computer-use:shell:write",
      },
      shellCreateInner$,
    ),
  },
  {
    route: computerUseHostsContract.list,
    handler: authRoute(computerUseHostListAuthOptions, hostsListInner$),
  },
  {
    route: computerUseCommandContract.create,
    handler: authRoute(computerUseCommandAuthOptions, commandCreateInner$),
  },
  {
    route: computerUseWriteCommandContract.create,
    handler: authRoute(computerUseCommandAuthOptions, writeCommandCreateInner$),
  },
  {
    route: computerUseCommandContract.get,
    handler: authRoute(computerUseCommandAuthOptions, commandGetInner$),
  },
  {
    route: computerUseCommandContract.getScreenshot,
    handler: authRoute(computerUseCommandAuthOptions, screenshotGetInner$),
  },
  {
    route: computerUseAuditEventsContract.list,
    handler: authRoute(computerUseAuthOptions, auditEventsListInner$),
  },
];
