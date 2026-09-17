import { morningBriefCalendarCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-calendar-collection-preview";

import { ROUTES } from "../signals/route";
import { assertUniqueRouteRegistrations } from "../signals/route-entry";

describe("API route registrations", () => {
  // Hono keeps both registrations for a duplicated path and answers with the
  // first, so a collision takes a handler over instead of failing. Asserted
  // over the route table rather than inside `createAppWithRoutes`, because
  // test apps deliberately compose overlapping route slices and would fail an
  // app-wide assertion for reasons that have nothing to do with the table.
  it("keeps the production route table free of colliding registrations", () => {
    expect(() => {
      assertUniqueRouteRegistrations(ROUTES);
    }).not.toThrow();
  });

  // The Morning Brief calendar preview is only a real consumer of the shared
  // connector reader while the deployed application actually serves it. A route
  // reachable solely from a test harness would pass its own suite and still be
  // absent in production, so the production table is asserted here, in one of
  // the few modules the import boundary lets read the aggregate.
  it("serves the Morning Brief calendar collection preview from the production table", () => {
    const { method, path } =
      morningBriefCalendarCollectionPreviewContract.collect;
    expect(
      ROUTES.some((entry) => {
        return entry.route.method === method && entry.route.path === path;
      }),
    ).toBeTruthy();
  });
});
