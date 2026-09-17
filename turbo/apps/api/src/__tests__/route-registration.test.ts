import { morningBriefCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import { morningBriefGithubCollectionContract } from "@okouai/api-contracts/contracts/morning-brief-github-collection";

import { ROUTES } from "../signals/route";
import { assertUniqueRouteRegistrations } from "../signals/route-entry";
import { morningBriefCollectionPreviewRoutes } from "../signals/routes/morning-brief-collection-preview";
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

  // The Morning Brief collection preview only means anything if an operator can
  // actually reach it on a development server or a protected preview
  // deployment, and its own suite may not compose an app from this
  // production-global table. Asserting the exact entry object keeps that suite's
  // results statements about the deployed endpoint rather than about a
  // look-alike slice: the handler it exercises is the handler `ROUTES` holds.
  it("registers the Morning Brief collection preview an operator invokes", () => {
    const [entry, ...extra] = morningBriefCollectionPreviewRoutes;
    expect(extra).toHaveLength(0);
    expect(entry?.route).toBe(morningBriefCollectionPreviewContract.collect);
    expect(ROUTES).toContain(entry);
    expect(
      ROUTES.filter((registered) => {
        return (
          registered.route.path ===
          morningBriefCollectionPreviewContract.collect.path
        );
      }),
    ).toStrictEqual([entry]);
  });

  // The same statement for the GitHub priorities preview: the deployed table
  // must hold this module's own entry object, so the behaviour suite that
  // drives that handler through the exported slice is talking about the
  // endpoint an operator actually reaches.
  it("registers the Morning Brief GitHub collection preview an operator invokes", () => {
    const [entry, ...extra] = morningBriefPreviewGithubCollectionRoutes;
    expect(extra).toHaveLength(0);
    expect(entry?.route).toBe(morningBriefGithubCollectionContract.collect);
    expect(ROUTES).toContain(entry);
    expect(
      ROUTES.filter((registered) => {
        return (
          registered.route.path ===
          morningBriefGithubCollectionContract.collect.path
        );
      }),
    ).toStrictEqual([entry]);
    expect(morningBriefGithubCollectionContract.collect.path).toBe(
      "/api/morning-brief/preview/github-collection",
    );
  });
});
