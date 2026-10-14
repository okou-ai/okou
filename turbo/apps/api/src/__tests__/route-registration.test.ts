import { ROUTES } from "../signals/route";
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
});
