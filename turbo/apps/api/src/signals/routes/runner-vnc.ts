import { runnerVncContract } from "@okouai/api-contracts/contracts/runner-vnc";
import { command } from "ccstate";
import { runnerAuth$ } from "../auth/runner-auth";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  checkRunnerVnc,
  resolveRunnerVnc,
} from "../services/runner-vnc.service";

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
    signal,
  );
  return { status: 200 as const, body: result };
});

export const runnerVncRoutes: readonly RouteEntry[] = [
  { route: runnerVncContract.resolve, handler: resolve$ },
  { route: runnerVncContract.check, handler: check$ },
];
