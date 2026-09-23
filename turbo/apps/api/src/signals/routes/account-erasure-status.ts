import { command } from "ccstate";

import { accountErasureStatusContract } from "@okouai/api-contracts/contracts/account-erasure-status";

import { notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$ } from "../context/hono";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  accountErasureStatus,
  createAccountErasureStatusCapability,
  userIdFromAccountErasureStatusCapability,
} from "../services/account-erasure-status.service";

const noStore = { "Cache-Control": "no-store" } as const;

const createCapability$ = command(({ get }, signal: AbortSignal) => {
  const owner = get(authContext$);
  const capability = createAccountErasureStatusCapability(owner.userId);
  signal.throwIfAborted();
  return { status: 200 as const, body: capability, headers: noStore };
});

const readStatus$ = command(async ({ get }, signal: AbortSignal) => {
  const authorization = get(authorization$);
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const userId = userIdFromAccountErasureStatusCapability(token);
  if (userId === null) {
    return notFound("Account deletion status unavailable");
  }
  const status = await accountErasureStatus(get(db$), userId);
  signal.throwIfAborted();
  return { status: 200 as const, body: { userId, status }, headers: noStore };
});

export const accountErasureStatusRoutes: readonly RouteEntry[] = [
  {
    route: accountErasureStatusContract.capability,
    handler: authRoute({ accept: ["session"] }, createCapability$),
  },
  { route: accountErasureStatusContract.status, handler: readStatus$ },
];
