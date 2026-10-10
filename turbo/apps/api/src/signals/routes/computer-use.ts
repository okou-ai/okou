import { command } from "ccstate";
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
  listComputerUseAuditEvents$,
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
