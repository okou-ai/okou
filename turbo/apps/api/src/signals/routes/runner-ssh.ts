import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { command } from "ccstate";

import { runnerAuth$ } from "../auth/runner-auth";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  pinRunnerSsh,
  resolveRunnerSsh,
  recordRunnerSshObservation,
} from "../services/runner-ssh.service";

const authorizeSshRunner$ = command(
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
              "Only official runners can access SSH runtime configuration",
          },
        },
      };
    }
    return null;
  },
);

const resolveSsh$ = command(async ({ get, set }, signal: AbortSignal) => {
  const error = await set(authorizeSshRunner$, signal);
  if (error) {
    return error;
  }
  const body = await get(bodyResultOf(runnerSshContract.resolve));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId } = get(pathParamsOf(runnerSshContract.resolve));
  const result = await resolveRunnerSsh(
    get(db$),
    {
      runId,
      ...body.data,
    },
    signal,
  );
  return { status: 200 as const, body: result };
});

const pinSsh$ = command(async ({ get, set }, signal: AbortSignal) => {
  const error = await set(authorizeSshRunner$, signal);
  if (error) {
    return error;
  }
  const body = await get(bodyResultOf(runnerSshContract.pin));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId } = get(pathParamsOf(runnerSshContract.pin));
  const result = await pinRunnerSsh(
    set(writeDb$),
    {
      runId,
      ...body.data,
    },
    signal,
  );
  return { status: 200 as const, body: result };
});

const observeSsh$ = command(async ({ get, set }, signal: AbortSignal) => {
  const error = await set(authorizeSshRunner$, signal);
  if (error) {
    return error;
  }
  const body = await get(bodyResultOf(runnerSshContract.observe));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId } = get(pathParamsOf(runnerSshContract.observe));
  const result = await recordRunnerSshObservation(
    set(writeDb$),
    { runId, ...body.data },
    signal,
  );
  return { status: 200 as const, body: result };
});

export const runnerSshRoutes: readonly RouteEntry[] = [
  { route: runnerSshContract.observe, handler: observeSsh$ },
  { route: runnerSshContract.resolve, handler: resolveSsh$ },
  { route: runnerSshContract.pin, handler: pinSsh$ },
];
