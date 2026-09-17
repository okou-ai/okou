import { morningBriefCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import { morningBriefGenerationPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";

import { ROUTES } from "../signals/route";
import { assertUniqueRouteRegistrations } from "../signals/route-entry";
import { morningBriefCollectionPreviewRoutes } from "../signals/routes/morning-brief-collection-preview";
import { morningBriefGenerationPreviewRoutes } from "../signals/routes/morning-brief-generation-preview";

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

  // The platform-funded generation preview has the same requirement: its own
  // suite may not compose an app from this production-global table, so the
  // exact entry object is asserted here. Registration is what makes that
  // suite's results statements about the deployed endpoint, and what makes the
  // production 404 a statement about a route that really exists.
  it("registers the Morning Brief generation preview an operator invokes", () => {
    const [entry, ...extra] = morningBriefGenerationPreviewRoutes;
    expect(extra).toHaveLength(0);
    expect(entry?.route).toBe(morningBriefGenerationPreviewContract.generate);
    expect(ROUTES).toContain(entry);
    expect(
      ROUTES.filter((registered) => {
        return (
          registered.route.path ===
          morningBriefGenerationPreviewContract.generate.path
        );
      }),
    ).toStrictEqual([entry]);
  });
});
