import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { z } from "zod";
import { dataRouterToolsContract } from "@okouai/api-contracts/contracts/data-router";
import {
  dataRouterToolsPageSchema,
  type DataRouterTool,
} from "@okouai/api-contracts/contracts/data-router-tools";
import { env } from "../../lib/env";
import { authRoute } from "../auth/auth-route";
import { requestSignal$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { settleIncludingAbort } from "../utils";

const list$ = command(async ({ get }, signal: AbortSignal) => {
  const endpoint = env("OKOU_DATA_ROUTER_URL");
  const token = env("OKOU_DATA_TOKEN");
  if (!endpoint || !token) {
    return {
      status: 503 as const,
      body: {
        error: {
          code: "DATA_ROUTER_UNAVAILABLE",
          message: "Data Router is not configured",
        },
      },
    };
  }
  const requestSignal = AbortSignal.any([
    signal,
    get(requestSignal$),
    AbortSignal.timeout(20_000),
  ]);
  const result = await settleIncludingAbort(
    (async () => {
      const tools: DataRouterTool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomUUID(),
            method: "tools/list",
            params: cursor ? { cursor } : {},
          }),
          signal: requestSignal,
        });
        if (!response.ok) {
          throw new Error("Data Router discovery failed");
        }
        const page = z
          .object({ result: dataRouterToolsPageSchema })
          .parse(await response.json()).result;
        tools.push(
          ...page.tools.filter((tool) => {
            return Boolean(tool._meta?.["ai.okou/data"]);
          }),
        );
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) {
          throw new Error("Data Router repeated a discovery cursor");
        }
        if (cursor) {
          cursors.add(cursor);
        }
      } while (cursor);
      return tools;
    })(),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return {
      status: 502 as const,
      body: {
        error: {
          code: "DATA_ROUTER_DISCOVERY_FAILED",
          message: "Could not load Data Router tools",
        },
      },
    };
  }
  return { status: 200 as const, body: { tools: result.value } };
});

export const dataRouterToolsRoutes: readonly RouteEntry[] = [
  {
    route: dataRouterToolsContract.list,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "data-search:read" },
      list$,
    ),
  },
];
