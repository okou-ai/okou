import { command } from "ccstate";
import { jobsContract } from "@okouai/api-contracts/contracts/jobs";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import {
  jobAccess$,
  readUserJob$,
  listUserJobs$,
  createUserJob$,
  updateUserJob$,
  appendUserJobInput$,
  appendUserJobObservation$,
  acknowledgeUserJobResult$,
  archiveUserJob$,
  deriveUserJobIdentity,
} from "../services/user-jobs.service";

const identity$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(jobAccess$, signal);
  if ("status" in owner) {
    return owner;
  }
  const body = await get(bodyResultOf(jobsContract.identity));
  signal.throwIfAborted();
  return body.ok
    ? {
        status: 200 as const,
        body: { id: deriveUserJobIdentity(owner, body.data.key) },
      }
    : body.response;
});

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await set(jobAccess$, signal);
  return "status" in owner
    ? owner
    : await set(listUserJobs$, owner, get(queryOf(jobsContract.list)), signal);
});
const read$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await set(jobAccess$, signal);
  return "status" in owner
    ? owner
    : await set(
        readUserJob$,
        owner,
        get(pathParamsOf(jobsContract.get)).id,
        signal,
      );
});
const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(jobAccess$, signal);
  if ("status" in owner) {
    return owner;
  }
  const body = await get(bodyResultOf(jobsContract.create));
  signal.throwIfAborted();
  return body.ok
    ? await set(createUserJob$, owner, body.data, signal)
    : body.response;
});
const update$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(jobAccess$, signal);
  if ("status" in owner) {
    return owner;
  }
  const body = await get(bodyResultOf(jobsContract.update));
  signal.throwIfAborted();
  return body.ok
    ? await set(
        updateUserJob$,
        owner,
        get(pathParamsOf(jobsContract.update)).id,
        body.data,
        signal,
      )
    : body.response;
});
const input$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(jobAccess$, signal);
  if ("status" in owner) {
    return owner;
  }
  const body = await get(bodyResultOf(jobsContract.input));
  signal.throwIfAborted();
  return body.ok
    ? await set(
        appendUserJobInput$,
        owner,
        get(pathParamsOf(jobsContract.input)).id,
        body.data,
        signal,
      )
    : body.response;
});
const viewed$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(jobAccess$, signal);
  if ("status" in owner) {
    return owner;
  }
  const body = await get(bodyResultOf(jobsContract.viewed));
  signal.throwIfAborted();
  return body.ok
    ? await set(
        acknowledgeUserJobResult$,
        owner,
        get(pathParamsOf(jobsContract.viewed)).id,
        body.data.resultId,
        signal,
      )
    : body.response;
});
const observe$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(jobAccess$, signal);
  if ("status" in owner) {
    return owner;
  }
  const body = await get(bodyResultOf(jobsContract.observe));
  signal.throwIfAborted();
  return body.ok
    ? await set(
        appendUserJobObservation$,
        owner,
        get(pathParamsOf(jobsContract.observe)).id,
        body.data,
        signal,
      )
    : body.response;
});
const archive$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await set(jobAccess$, signal);
  return "status" in owner
    ? owner
    : await set(
        archiveUserJob$,
        owner,
        get(pathParamsOf(jobsContract.archive)).id,
        signal,
      );
});
const readAuth = {
  accept: ["session", "agent"],
  requireOrganization: true,
  requiredCapability: "job:read",
} as const;
const writeAuth = {
  accept: ["agent"],
  requireOrganization: true,
  requiredCapability: "job:write",
} as const;
const userAuth = { accept: ["session"], requireOrganization: true } as const;
export const jobsRoutes: readonly RouteEntry[] = [
  { route: jobsContract.identity, handler: authRoute(readAuth, identity$) },
  { route: jobsContract.list, handler: authRoute(readAuth, list$) },
  { route: jobsContract.get, handler: authRoute(readAuth, read$) },
  { route: jobsContract.create, handler: authRoute(writeAuth, create$) },
  { route: jobsContract.update, handler: authRoute(writeAuth, update$) },
  { route: jobsContract.input, handler: authRoute(userAuth, input$) },
  { route: jobsContract.observe, handler: authRoute(writeAuth, observe$) },
  { route: jobsContract.viewed, handler: authRoute(userAuth, viewed$) },
  { route: jobsContract.archive, handler: authRoute(userAuth, archive$) },
];
