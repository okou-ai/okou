import { cronRefreshHomeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/cron";

import { ROUTES } from "../signals/route";
import { cronRefreshHomeTaskRecommendationsRoutes } from "../signals/routes/cron-refresh-home-task-recommendations";
import { assertUniqueRouteRegistrations } from "../signals/route-entry";
import { mcpServerRoutes } from "../signals/routes/mcp-server";

describe("API route registrations", () => {
  it("registers the hosted MCP endpoint and resource metadata", () => {
    for (const entry of mcpServerRoutes) {
      expect(ROUTES).toContain(entry);
    }
  });

  // Hono keeps both registrations for a duplicated path and answers with the
  // first, so a collision takes a handler over instead of failing. Asserted
  // over the route table rather than inside `createAppWithRoutes`, because
  // test apps deliberately compose overlapping route slices.
  it("keeps the production route table free of colliding registrations", () => {
    expect(() => {
      assertUniqueRouteRegistrations(ROUTES);
    }).not.toThrow();
  });

  it("does not expose retired Native Morning Brief execution or preview routes", () => {
    expect(
      ROUTES.map(({ route }) => {
        return route.path;
      }).filter((path) => {
        return /^\/api\/(?:morning-brief\/(?:preview|collection-preview)\/|debug\/morning-brief-trigger$|cron\/execute-morning-briefs$|internal\/morning-brief-worker$)/.test(
          path,
        );
      }),
    ).toStrictEqual([]);
  });

  it("registers the home-task refresh cron", () => {
    const [entry, ...extra] = cronRefreshHomeTaskRecommendationsRoutes;
    expect(extra).toHaveLength(0);
    expect(entry?.route).toBe(
      cronRefreshHomeTaskRecommendationsContract.refresh,
    );
    expect(ROUTES).toContain(entry);
  });
});
