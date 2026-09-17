import { morningBriefGithubCollectionContract } from "@okouai/api-contracts/contracts/morning-brief-github-collection";

import { ROUTES } from "../signals/route";
import { assertUniqueRouteRegistrations } from "../signals/route-entry";
import { morningBriefPreviewGithubCollectionRoutes } from "../signals/routes/morning-brief-preview-github-collection";

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

  /**
   * The Morning Brief GitHub preview is environment-gated, not test-mounted.
   *
   * `api/no-global-sweep-test-routes` forbids composing the production table
   * into a test app, so ingress is proven structurally instead: the deployed
   * table must carry this module's *own* handler object for the contract's
   * path. The behaviour suite then exercises that same handler through the
   * exported slice, so a preview that existed only inside its own suite would
   * fail here rather than pass quietly.
   */
  it("registers the Morning Brief GitHub collection preview handler", () => {
    const expected = morningBriefPreviewGithubCollectionRoutes[0];
    const registered = ROUTES.filter((entry) => {
      return entry.route === morningBriefGithubCollectionContract.collect;
    });

    expect(expected).toBeDefined();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.handler).toBe(expected?.handler);
    expect(morningBriefGithubCollectionContract.collect.path).toBe(
      "/api/morning-brief/preview/github-collection",
    );
  });
});
