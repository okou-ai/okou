import { iosResponseTransforms } from "@okouai/api-contracts/client-transforms/ios";
import { desktopResponseTransforms } from "@okouai/api-contracts/client-transforms/desktop";

import { ROUTES } from "../signals/route";
import { assertUniqueRouteRegistrations } from "../signals/route-entry";
import { mcpServerRoutes } from "../signals/routes/mcp-server";

describe("API route registrations", () => {
  it("registers the hosted MCP endpoint and resource metadata", () => {
    for (const entry of mcpServerRoutes) {
      expect(ROUTES).toContain(entry);
    }
  });

  it("mounts the native client compatibility inventories on its owning routes", () => {
    const transforms = [...desktopResponseTransforms, ...iosResponseTransforms];
    for (const transform of transforms) {
      const entry = ROUTES.find(({ route }) => {
        return (
          route.method === transform.method && route.path === transform.path
        );
      });
      expect(entry?.responseTransforms).toContain(transform);
    }
    for (const entry of ROUTES) {
      const expected = transforms.filter((transform) => {
        return (
          transform.method === entry.route.method &&
          transform.path === entry.route.path
        );
      });
      expect(entry.responseTransforms ?? []).toStrictEqual(expected);
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
