import { morningBriefCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import { morningBriefGenerationPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import { morningBriefGmailCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-gmail-collection-preview";

import { ROUTES } from "../signals/route";
import { assertUniqueRouteRegistrations } from "../signals/route-entry";
import { morningBriefCollectionPreviewRoutes } from "../signals/routes/morning-brief-collection-preview";
import { morningBriefGenerationPreviewRoutes } from "../signals/routes/morning-brief-generation-preview";
import { morningBriefGmailCollectionPreviewRoutes } from "../signals/routes/morning-brief-gmail-collection-preview";

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

  // Same requirement for the Gmail preview, which is the first real consumer of
  // the shared connector reader. A route reachable only from a test harness
  // would pass its own suite and still be absent from the deployed table.
  it("registers the Morning Brief Gmail collection preview an operator invokes", () => {
    const [entry, ...extra] = morningBriefGmailCollectionPreviewRoutes;
    expect(extra).toHaveLength(0);
    expect(entry?.route).toBe(
      morningBriefGmailCollectionPreviewContract.collect,
    );
    expect(ROUTES).toContain(entry);
    expect(
      ROUTES.filter((registered) => {
        return (
          registered.route.path ===
          morningBriefGmailCollectionPreviewContract.collect.path
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
    expect(entry?.route).toBe(morningBriefGenerationPreviewContract.preview);
    expect(ROUTES).toContain(entry);
    expect(
      ROUTES.filter((registered) => {
        return (
          registered.route.path ===
          morningBriefGenerationPreviewContract.preview.path
        );
      }),
    ).toStrictEqual([entry]);
  });
});
