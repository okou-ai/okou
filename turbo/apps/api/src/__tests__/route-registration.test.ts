import { morningBriefGithubCollectionContract } from "@okouai/api-contracts/contracts/morning-brief-github-collection";

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

  // The Morning Brief GitHub preview is environment-gated, not test-mounted. A
  // preview that only exists inside its own suite would pass every behaviour
  // assertion while the deployed application served nothing, so its ingress is
  // asserted here, in the one test file allowed to read the route table.
  it("registers the Morning Brief GitHub collection preview", () => {
    const registered = ROUTES.some((entry) => {
      return entry.route === morningBriefGithubCollectionContract.collect;
    });

    expect(registered).toBeTruthy();
  });
});
