import { desktopResponseTransforms } from "@okouai/api-contracts/client-transforms/desktop";
import { ROUTES } from "../signals/route";
import { assertUniqueRouteRegistrations } from "../signals/route-entry";
import { mcpServerRoutes } from "../signals/routes/mcp-server";

describe("API route registrations", () => {
  it("mounts every compatibility transform on its declared production route", () => {
    const mounted = ROUTES.flatMap((entry) => {
      const transforms = entry.responseTransforms ?? [];
      for (const transform of transforms) {
        expect(transform.method).toBe(entry.route.method);
        expect(transform.path).toBe(entry.route.path);
        expect(entry.route.responses).toHaveProperty(String(transform.status));
      }
      return transforms;
    });
    expect(mounted).toStrictEqual(desktopResponseTransforms);
  });

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
