import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { command, computed } from "ccstate";

import { runnerAuth$ } from "../auth/runner-auth";
import {
  authorization$,
  runnerRemoteDevicePolicy$,
  setResHeader$,
} from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  pinRunnerSsh$,
  resolveRunnerSsh$,
  recordRunnerSshObservation$,
  createCurrentRunnerSshConnection,
  checkRunnerSsh$,
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

const resolveInput$ = computed(async (get) => {
  const body = await get(bodyResultOf(runnerSshContract.resolve));
  return body.ok
    ? {
        ...get(pathParamsOf(runnerSshContract.resolve)),
        ...body.data,
        supportsDevicePolicy: get(runnerRemoteDevicePolicy$) === "1",
      }
    : null;
});
const pinInput$ = computed(async (get) => {
  const body = await get(bodyResultOf(runnerSshContract.pin));
  return body.ok
    ? {
        ...get(pathParamsOf(runnerSshContract.pin)),
        ...body.data,
        supportsDevicePolicy: get(runnerRemoteDevicePolicy$) === "1",
      }
    : null;
});
const observationInput$ = computed(async (get) => {
  const body = await get(bodyResultOf(runnerSshContract.observe));
  return body.ok
    ? {
        ...get(pathParamsOf(runnerSshContract.observe)),
        ...body.data,
        supportsDevicePolicy: get(runnerRemoteDevicePolicy$) === "1",
      }
    : null;
});
const resolveConnection$ = createCurrentRunnerSshConnection(resolveInput$);
const pinConnection$ = createCurrentRunnerSshConnection(pinInput$);
const observationConnection$ =
  createCurrentRunnerSshConnection(observationInput$);

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
  const selected = await get(resolveConnection$);
  signal.throwIfAborted();
  const result = await set(resolveRunnerSsh$, selected, signal);
  if (result.outcome !== "unavailable" && selected !== null) {
    set(setResHeader$, "X-SSH-Connection-Created-At", selected.createdAt);
    if (selected.remoteDeviceMode) {
      set(setResHeader$, "X-Okou-Remote-Device-Policy", "1");
    }
  }
  return { status: 200 as const, body: result };
});

const checkSsh$ = command(async ({ get, set }, signal: AbortSignal) => {
  const error = await set(authorizeSshRunner$, signal);
  if (error) {
    return error;
  }
  const body = await get(bodyResultOf(runnerSshContract.check));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    checkRunnerSsh$,
    {
      ...get(pathParamsOf(runnerSshContract.check)),
      ...body.data,
      supportsDevicePolicy: get(runnerRemoteDevicePolicy$) === "1",
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
  const initial = await get(pinConnection$);
  signal.throwIfAborted();
  const result = await set(
    pinRunnerSsh$,
    {
      input: {
        runId,
        ...body.data,
        supportsDevicePolicy: get(runnerRemoteDevicePolicy$) === "1",
      },
      initial,
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
  const initial = await get(observationConnection$);
  signal.throwIfAborted();
  const result = await set(
    recordRunnerSshObservation$,
    {
      input: {
        runId,
        ...body.data,
        supportsDevicePolicy: get(runnerRemoteDevicePolicy$) === "1",
      },
      initial,
    },
    signal,
  );
  return { status: 200 as const, body: result };
});

export const runnerSshRoutes: readonly RouteEntry[] = [
  { route: runnerSshContract.check, handler: checkSsh$ },
  { route: runnerSshContract.observe, handler: observeSsh$ },
  { route: runnerSshContract.resolve, handler: resolveSsh$ },
  { route: runnerSshContract.pin, handler: pinSsh$ },
];
