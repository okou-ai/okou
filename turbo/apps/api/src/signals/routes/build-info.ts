import { command } from "ccstate";
import {
  buildInfoContract,
  type BuildInfoRouteResponse,
} from "@okouai/api-contracts/contracts/build-info";

import { getBuildVersion, normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";

const apiBuildInfo$ = command(
  ({ set }, _signal: AbortSignal): BuildInfoRouteResponse => {
    set(setResHeader$, "Cache-Control", "no-store");

    return {
      status: 200,
      body: {
        commitSha: normalizeBuildCommitSha(env("GIT_COMMIT_SHA")),
        version: getBuildVersion(),
      },
    };
  },
);

export const buildInfoRoutes: readonly RouteEntry[] = [
  { route: buildInfoContract.get, handler: apiBuildInfo$ },
];
