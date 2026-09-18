import { runnerVncContract } from "@okouai/api-contracts/contracts/runner-vnc";
import { command } from "ccstate";
import { runnerAuth$ } from "../auth/runner-auth";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { resolveRunnerVnc } from "../services/runner-vnc.service";
import {
  acquireRunnerVnc,
  checkRunnerVnc,
  releaseRunnerVnc,
} from "../services/runner-vnc-lease.service";

const authorizeVncRunner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "no-store");
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return {
        status: 401 as const,
        body: {
          error: { code: "UNAUTHORIZED", message: "Authentication required" },
        },
      };
    }
    if (auth.type !== "official-runner") {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN",
            message:
              "Only official runners can access VNC runtime configuration",
          },
        },
      };
    }
    return null;
  },
);

const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  const error = await set(authorizeVncRunner$, signal);
  if (error) {
    return error;
  }
  const body = await get(bodyResultOf(runnerVncContract.resolve));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId } = get(pathParamsOf(runnerVncContract.resolve));
  const result = await resolveRunnerVnc(
    set(writeDb$),
    get(clerk$),
    { runId, ...body.data },
    signal,
  );
  return { status: 200 as const, body: result };
});

const acquire$ = command(async ({ get, set }, signal: AbortSignal) => {
  const error = await set(authorizeVncRunner$, signal);
  if (error) {
    return error;
  }
  const body = await get(bodyResultOf(runnerVncContract.acquire));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId } = get(pathParamsOf(runnerVncContract.acquire));
  const result = await acquireRunnerVnc(
    set(writeDb$),
    get(clerk$),
    { runId, ...body.data },
    signal,
  );
  return { status: 200 as const, body: result };
});

const check$ = command(async ({ get, set }, signal: AbortSignal) => {
  const error = await set(authorizeVncRunner$, signal);
  if (error) {
    return error;
  }
  const body = await get(bodyResultOf(runnerVncContract.check));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId } = get(pathParamsOf(runnerVncContract.check));
  const result = await checkRunnerVnc(
    set(writeDb$),
    get(clerk$),
    { runId, ...body.data },
    false,
    signal,
  );
  return { status: 200 as const, body: result };
});

const renew$ = command(async ({ get, set }, signal: AbortSignal) => {
  const error = await set(authorizeVncRunner$, signal);
  if (error) {
    return error;
  }
  const body = await get(bodyResultOf(runnerVncContract.renew));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId } = get(pathParamsOf(runnerVncContract.renew));
  const result = await checkRunnerVnc(
    set(writeDb$),
    get(clerk$),
    { runId, ...body.data },
    true,
    signal,
  );
  return { status: 200 as const, body: result };
});

const release$ = command(async ({ get, set }, signal: AbortSignal) => {
  const error = await set(authorizeVncRunner$, signal);
  if (error) {
    return error;
  }
  const body = await get(bodyResultOf(runnerVncContract.release));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId } = get(pathParamsOf(runnerVncContract.release));
  const result = await releaseRunnerVnc(
    set(writeDb$),
    get(clerk$),
    { runId, ...body.data },
    signal,
  );
  return { status: 200 as const, body: result };
});

export const runnerVncRoutes: readonly RouteEntry[] = [
  { route: runnerVncContract.resolve, handler: resolve$ },
  { route: runnerVncContract.acquire, handler: acquire$ },
  { route: runnerVncContract.check, handler: check$ },
  { route: runnerVncContract.renew, handler: renew$ },
  { route: runnerVncContract.release, handler: release$ },
];
