import { morningBriefCalendarCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-calendar-collection-preview";
import { morningBriefChatCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-chat-collection-preview";
import { morningBriefCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { morningBriefDeliveryPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-delivery-preview";
import { morningBriefGenerationPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import { morningBriefGithubCollectionContract } from "@okouai/api-contracts/contracts/morning-brief-github-collection";
import { morningBriefGmailCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-gmail-collection-preview";

import { cronExecuteMorningBriefsContract } from "@okouai/api-contracts/contracts/cron";

import { ROUTES } from "../signals/route";
import { cronExecuteMorningBriefsRoutes } from "../signals/routes/cron-execute-morning-briefs";
import { assertUniqueRouteRegistrations } from "../signals/route-entry";
import { morningBriefCalendarCollectionPreviewRoutes } from "../signals/routes/morning-brief-calendar-collection-preview";
import { morningBriefChatCollectionPreviewRoutes } from "../signals/routes/morning-brief-chat-collection-preview";
import { morningBriefCollectionPreviewRoutes } from "../signals/routes/morning-brief-collection-preview";
import { morningBriefCompositionPreviewRoutes } from "../signals/routes/morning-brief-composition-preview";
import { morningBriefDeliveryPreviewRoutes } from "../signals/routes/morning-brief-delivery-preview";
import { morningBriefGenerationPreviewRoutes } from "../signals/routes/morning-brief-generation-preview";
import { morningBriefGmailCollectionPreviewRoutes } from "../signals/routes/morning-brief-gmail-collection-preview";
import { morningBriefPreviewGithubCollectionRoutes } from "../signals/routes/morning-brief-preview-github-collection";
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
  // test apps deliberately compose overlapping route slices and would fail an
  // app-wide assertion for reasons that have nothing to do with the table.
  it("keeps the production route table free of colliding registrations", () => {
    expect(() => {
      assertUniqueRouteRegistrations(ROUTES);
    }).not.toThrow();
  });

  // A collection preview only means anything if an operator can actually reach
  // it on a development server or a protected preview deployment, and its own
  // suite composes an app from a route slice rather than from this
  // production-global table. A route reachable only from a test harness would
  // pass its own suite and still be absent from the deployed table. Asserting
  // the exact entry object keeps those suites' results statements about the
  // deployed endpoint rather than about a look-alike slice: the handler they
  // exercise is the handler `ROUTES` holds.
  it.each([
    {
      name: "Morning Brief collection preview",
      routes: morningBriefCollectionPreviewRoutes,
      route: morningBriefCollectionPreviewContract.collect,
    },
    {
      name: "Morning Brief Gmail collection preview",
      routes: morningBriefGmailCollectionPreviewRoutes,
      route: morningBriefGmailCollectionPreviewContract.collect,
    },
    {
      name: "Morning Brief Chat collection preview",
      routes: morningBriefChatCollectionPreviewRoutes,
      route: morningBriefChatCollectionPreviewContract.collect,
    },
    {
      name: "Morning Brief calendar collection preview",
      routes: morningBriefCalendarCollectionPreviewRoutes,
      route: morningBriefCalendarCollectionPreviewContract.collect,
    },
    {
      name: "Morning Brief composition preview",
      routes: morningBriefCompositionPreviewRoutes,
      route: morningBriefCompositionPreviewContract.compose,
    },
  ])("registers the $name an operator invokes", ({ routes, route }) => {
    const [entry, ...extra] = routes;
    expect(extra).toHaveLength(0);
    expect(entry?.route).toBe(route);
    expect(ROUTES).toContain(entry);
    expect(
      ROUTES.filter((registered) => {
        return registered.route.path === route.path;
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

  // And for the GitHub priorities preview, the reader's second collection
  // consumer: the deployed table must hold this module's own entry object, so
  // the behaviour suite that drives that handler through the exported slice is
  // talking about the endpoint an operator actually reaches.
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

  // Delivery has the same requirement, and one more reason: its production 404
  // is only a statement about a route that really exists if the deployed table
  // is the table that holds it.
  it("registers the Morning Brief delivery preview an operator invokes", () => {
    const [entry, ...extra] = morningBriefDeliveryPreviewRoutes;
    expect(extra).toHaveLength(0);
    expect(entry?.route).toBe(morningBriefDeliveryPreviewContract.preview);
    expect(ROUTES).toContain(entry);
    expect(
      ROUTES.filter((registered) => {
        return (
          registered.route.path ===
          morningBriefDeliveryPreviewContract.preview.path
        );
      }),
    ).toStrictEqual([entry]);
  });

  // The native cron is not a preview: it is the deployed scheduling entry point
  // the platform invokes every minute, and its own suite composes an app from
  // this route slice. Asserting the exact entry object keeps that suite's
  // results statements about the endpoint the deployed table actually holds.
  it("registers the native Morning Brief cron the platform invokes", () => {
    const [entry, ...extra] = cronExecuteMorningBriefsRoutes;
    expect(extra).toHaveLength(0);
    expect(entry?.route).toBe(cronExecuteMorningBriefsContract.execute);
    expect(ROUTES).toContain(entry);
    expect(
      ROUTES.filter((registered) => {
        return (
          registered.route.path ===
          cronExecuteMorningBriefsContract.execute.path
        );
      }),
    ).toStrictEqual([entry]);
  });
});
