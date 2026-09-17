import { morningBriefCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import { morningBriefGenerationPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import { morningBriefGmailCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-gmail-collection-preview";

import { ROUTES } from "../signals/route";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
} from "../signals/route-entry";
import { morningBriefCollectionPreviewRoutes } from "../signals/routes/morning-brief-collection-preview";
import { morningBriefGenerationPreviewRoutes } from "../signals/routes/morning-brief-generation-preview";
import { morningBriefGmailCollectionPreviewRoutes } from "../signals/routes/morning-brief-gmail-collection-preview";
import { morningBriefDeliveryPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-delivery-preview";
import { morningBriefDeliveryPreviewRoutes } from "../signals/routes/morning-brief-delivery-preview";
import { morningBriefChatCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-chat-collection-preview";

import { morningBriefChatCollectionPreviewRoutes } from "../signals/routes/morning-brief-chat-collection-preview";
import { cronExecuteMorningBriefsContract } from "@okouai/api-contracts/contracts/cron";
import { cronExecuteMorningBriefsRoutes } from "../signals/routes/cron-execute-morning-briefs";

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

  it("registers the Morning Brief collection preview an operator invokes", () => {
    expect(
      registrationFacts(
        morningBriefCollectionPreviewRoutes,
        morningBriefCollectionPreviewContract.collect,
      ),
    ).toStrictEqual(soleProductionRegistration());
  });

  it("registers the Morning Brief Gmail collection preview an operator invokes", () => {
    expect(
      registrationFacts(
        morningBriefGmailCollectionPreviewRoutes,
        morningBriefGmailCollectionPreviewContract.collect,
      ),
    ).toStrictEqual(soleProductionRegistration());
  });

  // The native cron is not a preview: it is the deployed scheduling entry point
  // the platform invokes every minute. Its own suite composes an app from this
  // route slice, so the production table has to be the table that holds it.
  it("registers the native Morning Brief cron the platform invokes", () => {
    expect(
      registrationFacts(
        cronExecuteMorningBriefsRoutes,
        cronExecuteMorningBriefsContract.execute,
      ),
    ).toStrictEqual(soleProductionRegistration());
  });

  // Delivery has the same requirement, and one more reason: its production 404
  // is only a statement about a route that really exists if the deployed table
  // is the table that holds it.

  it("registers the Morning Brief Chat collection preview an operator invokes", () => {
    expect(
      registrationFacts(
        morningBriefChatCollectionPreviewRoutes,
        morningBriefChatCollectionPreviewContract.collect,
      ),
    ).toStrictEqual(soleProductionRegistration());
  });

  it("registers the Morning Brief generation preview an operator invokes", () => {
    expect(
      registrationFacts(
        morningBriefGenerationPreviewRoutes,
        morningBriefGenerationPreviewContract.preview,
      ),
    ).toStrictEqual(soleProductionRegistration());
  });

  // Delivery has the same requirement, and one more reason: its production 404
  // is only a statement about a route that really exists if the deployed table
  // is the table that holds it.
  it("registers the Morning Brief delivery preview an operator invokes", () => {
    expect(
      registrationFacts(
        morningBriefDeliveryPreviewRoutes,
        morningBriefDeliveryPreviewContract.preview,
      ),
    ).toStrictEqual(soleProductionRegistration());
  });

  // The platform-funded generation preview has the same requirement: its own
  // suite may not compose an app from this production-global table, so the
  // exact entry object is asserted here. Registration is what makes that
  // suite's results statements about the deployed endpoint, and what makes the
  // production 404 a statement about a route that really exists.
});

/**
 * A preview endpoint only means anything if an operator can actually reach it
 * on a development server or a protected preview deployment, and each suite
 * composes an app from its own route slice rather than from this
 * production-global table. Asserting the exact entry object keeps those suites'
 * results statements about the deployed endpoint rather than about a look-alike
 * slice: the handler they exercise is the handler `ROUTES` holds.
 */
interface RegistrationFacts {
  readonly extraRegistrations: number;
  readonly exportsTheContractRoute: boolean;
  readonly heldByTheProductionTable: boolean;
  readonly registrationsForThatPath: number;
}

/** What a correctly registered, non-colliding endpoint looks like. */
function soleProductionRegistration(): RegistrationFacts {
  return {
    extraRegistrations: 0,
    exportsTheContractRoute: true,
    heldByTheProductionTable: true,
    registrationsForThatPath: 1,
  };
}

function registrationFacts(
  routes: readonly RouteEntry[],
  route: RouteEntry["route"],
): RegistrationFacts {
  const [entry, ...extra] = routes;
  return {
    extraRegistrations: extra.length,
    exportsTheContractRoute: entry?.route === route,
    // The exact entry object, not a look-alike: the handler the suite
    // exercises has to be the handler `ROUTES` holds.
    heldByTheProductionTable: entry !== undefined && ROUTES.includes(entry),
    registrationsForThatPath: ROUTES.filter((registered) => {
      return registered.route.path === route.path;
    }).length,
  };
}
