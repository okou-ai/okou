import { runnerVncContract } from "@okouai/api-contracts/contracts/runner-vnc";
import { command } from "ccstate";
import { runnerAuth$ } from "../auth/runner-auth";
import { publishUserSignal } from "../external/realtime";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  checkRunnerVnc$,
  resolveRunnerVnc$,
} from "../services/runner-vnc.service";
import { recordVncConnectionObservation$ } from "../services/vnc-connection-observations.service";

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
  const result = await set(resolveRunnerVnc$, { runId, ...body.data }, signal);
  if (result.createdAt !== null) {
    set(setResHeader$, "X-VNC-Connection-Created-At", result.createdAt);
  }
  return { status: 200 as const, body: result.response };
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
  const result = await set(checkRunnerVnc$, { runId, ...body.data }, signal);
  return { status: 200 as const, body: { outcome: result.outcome } };
});

const observe$ = command(async ({ get, set }, signal: AbortSignal) => {
  const error = await set(authorizeVncRunner$, signal);
  if (error) {
    return error;
  }
  const body = await get(bodyResultOf(runnerVncContract.observe));
  signal.throwIfAborted();
  if (!body.ok) {
    return {
      status: 400 as const,
      body: {
        error: { code: "INVALID_INPUT", message: "Invalid VNC observation" },
      },
    };
  }
  const { runId } = get(pathParamsOf(runnerVncContract.observe));
  const input = { runId, ...body.data };
  const checked = await set(checkRunnerVnc$, input, signal);
  if (checked.outcome !== "valid") {
    return {
      status: 200 as const,
      body: {
        outcome:
          checked.outcome === "configuration_changed"
            ? ("ignored" as const)
            : ("unavailable" as const),
      },
    };
  }
  const result = await set(
    recordVncConnectionObservation$,
    input,
    checked.owner,
    signal,
  );
  if (result.outcome === "recorded") {
    await publishUserSignal(
      [checked.owner.userId],
      "vnc:observations-changed",
      {
        orgId: checked.owner.orgId,
      },
    );
    signal.throwIfAborted();
  }
  return { status: 200 as const, body: result };
});

export const runnerVncRoutes: readonly RouteEntry[] = [
  { route: runnerVncContract.observe, handler: observe$ },
  { route: runnerVncContract.resolve, handler: resolve$ },
  { route: runnerVncContract.check, handler: check$ },
];
