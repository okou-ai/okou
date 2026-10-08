import { command } from "ccstate";
import {
  computerUseAuditEventsContract,
  computerUseCommandContract,
  computerUseHeartbeatContract,
  computerUseHostCommandsContract,
  computerUseHostsContract,
  computerUseWriteCommandContract,
} from "@okouai/api-contracts/contracts/computer-use";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import {
  claimNextComputerUseHostCommand$,
  completeComputerUseHostCommand$,
  createComputerUseCommand$,
  getComputerUseCommand$,
  getComputerUseCommandScreenshot$,
  heartbeatComputerUseHost$,
  listComputerUseAuditEvents$,
  listComputerUseHosts$,
  startComputerUseHost$,
  stopComputerUseHost$,
} from "../services/computer-use.service";
import { computerUseSessionHostRoutes } from "./computer-use-session-hosts";
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

const invalidComputerUseToken = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Invalid computer-use host token",
      code: "UNAUTHORIZED",
    }),
  }),
});

const unauthorizedComputerUse = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Missing computer-use host token",
      code: "UNAUTHORIZED",
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

function parseBearerToken(authorization: string | undefined): string | null {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return null;
  }
  const token = authorization.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}

const hostStartBody$ = bodyResultOf(computerUseHostsContract.start);
const hostStartInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(hostStartBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    startComputerUseHost$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.status !== "started" || result.hostToken === null) {
    throw new Error("Legacy host START did not issue its credential");
  }
  return {
    status: 200 as const,
    body: { hostId: result.hostId, hostToken: result.hostToken },
  };
});

const heartbeatBody$ = bodyResultOf(computerUseHeartbeatContract.heartbeat);
const heartbeatInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const hostToken = parseBearerToken(get(authorization$));
  if (!hostToken) {
    return unauthorizedComputerUse;
  }
  const result = await set(
    heartbeatComputerUseHost$,
    { hostToken, ...bodyResult.data },
    signal,
  );
  signal.throwIfAborted();

  if (result.status === "invalid_token") {
    return invalidComputerUseToken;
  }
  return {
    status: 200 as const,
    body: { ok: true as const, hostId: result.hostId },
  };
});

const hostStopBody$ = bodyResultOf(computerUseHeartbeatContract.stop);
const hostStopInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(hostStopBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const hostToken = parseBearerToken(get(authorization$));
  if (!hostToken) {
    return unauthorizedComputerUse;
  }

  const result = await set(stopComputerUseHost$, { hostToken }, signal);
  signal.throwIfAborted();

  if (result.status === "invalid_token") {
    return invalidComputerUseToken;
  }
  return {
    status: 200 as const,
    body: { ok: true as const, hostId: result.hostId },
  };
});

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

    return {
      status: 200 as const,
      body: { commandId: result.commandId, status: result.commandStatus },
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

    return {
      status: 200 as const,
      body: { commandId: result.commandId, status: result.commandStatus },
    };
  },
);

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

const hostCommandNextBody$ = bodyResultOf(computerUseHostCommandsContract.next);
const hostCommandNextInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(hostCommandNextBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const hostToken = parseBearerToken(get(authorization$));
    if (!hostToken) {
      return unauthorizedComputerUse;
    }

    const result = await set(
      claimNextComputerUseHostCommand$,
      {
        hostToken,
        supportedCapabilities: bodyResult.data.supportedCapabilities,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid_token") {
      return invalidComputerUseToken;
    }
    if (result.status === "idle") {
      return { status: 200 as const, body: { status: "idle" as const } };
    }

    return {
      status: 200 as const,
      body: { status: "command" as const, command: result.command },
    };
  },
);

const hostCommandCompleteBody$ = bodyResultOf(
  computerUseHostCommandsContract.complete,
);
const hostCommandCompleteParams$ = pathParamsOf(
  computerUseHostCommandsContract.complete,
);
const hostCommandCompleteInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(hostCommandCompleteBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const hostToken = parseBearerToken(get(authorization$));
    if (!hostToken) {
      return unauthorizedComputerUse;
    }

    const params = get(hostCommandCompleteParams$);
    const commandResult =
      bodyResult.data.status === "succeeded"
        ? {
            hostToken,
            commandId: params.commandId,
            status: bodyResult.data.status,
            result: bodyResult.data.result,
          }
        : {
            hostToken,
            commandId: params.commandId,
            status: bodyResult.data.status,
            error: bodyResult.data.error,
          };
    const result = await set(
      completeComputerUseHostCommand$,
      commandResult,
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "invalid_token") {
      return invalidComputerUseToken;
    }
    if (result.status === "not_found") {
      return notFound("Computer-use command not found");
    }
    if (result.status === "not_running") {
      return conflict("Computer-use command is not running");
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

const auditEventsQuery$ = queryOf(computerUseAuditEventsContract.list);
const auditEventsListInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(auditEventsQuery$);
    const body = await set(
      listComputerUseAuditEvents$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        limit: query.limit,
        ...(query.commandId ? { commandId: query.commandId } : {}),
        ...(query.hostId ? { hostId: query.hostId } : {}),
        ...(query.runId ? { runId: query.runId } : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

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
    route: computerUseHostsContract.start,
    handler: authRoute(computerUseAuthOptions, hostStartInner$),
  },
  {
    route: computerUseHeartbeatContract.heartbeat,
    handler: heartbeatInner$,
  },
  {
    route: computerUseHeartbeatContract.stop,
    handler: hostStopInner$,
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
    route: computerUseHostCommandsContract.next,
    handler: hostCommandNextInner$,
  },
  {
    route: computerUseHostCommandsContract.complete,
    handler: hostCommandCompleteInner$,
  },
  {
    route: computerUseAuditEventsContract.list,
    handler: authRoute(computerUseAuthOptions, auditEventsListInner$),
  },
];
