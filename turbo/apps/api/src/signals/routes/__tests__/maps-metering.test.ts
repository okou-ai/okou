import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createBddApi } from "./helpers/api-bdd";
import { createMapsBillingApi } from "./helpers/api-bdd-maps-billing";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  VERTEX_MAPS_URL,
  vertexMapsContent,
  vertexMapsResponse,
} from "./helpers/google-maps-grounding";

const context = testContext();

async function setupMaps() {
  const bdd = createBddApi(context);
  const billing = createMapsBillingApi(context);
  const runs = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  await runs.grantProEntitlement(actor);
  billing.configureMapsProvider();
  return { billing, actor };
}

const validResponse = vertexMapsContent();
const validCandidate = validResponse.candidates[0]!;

describe("Maps generateContent usage and citations", () => {
  it.each([
    { mapsQueries: 0, providerCost: 100, credits: 1 },
    { mapsQueries: 3, providerCost: 42_100, credits: 53 },
    { mapsQueries: 4, providerCost: 56_100, credits: 71 },
  ])(
    "bills $mapsQueries executed queries independently of source count and admission estimate",
    async ({ mapsQueries, providerCost, credits }) => {
      const { billing, actor } = await setupMaps();
      server.use(
        http.post(VERTEX_MAPS_URL, () => {
          return vertexMapsResponse({ mapsQueries });
        }),
      );
      const before = await billing.readBillingStatus(actor);
      const search = await billing.requestMapsSearch(
        actor,
        { query: "Find coffee near Union Square" },
        [200],
      );
      expect(search.body).toMatchObject({
        billingQuantity: providerCost,
        providerCostUsd: providerCost / 1_000_000,
        creditsCharged: credits,
        usage: { inputTokens: 100, outputTokens: 50, mapsQueries },
      });
      expect(search.body).toHaveProperty(
        "sources.length",
        mapsQueries === 0 ? 0 : 1,
      );
      expect((await billing.readBillingStatus(actor)).credits).toBe(
        before.credits - credits,
      );
    },
  );

  it("counts repeated executed queries even when they produce no cited places", async () => {
    const { billing, actor } = await setupMaps();
    const response = vertexMapsContent({
      answer: "No matching places were found.",
      sources: [],
      supports: [],
    });
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return HttpResponse.json({
          ...response,
          candidates: [
            {
              ...response.candidates[0],
              groundingMetadata: {
                retrievalQueries: [
                  "cafe in a small town",
                  "cafe in a small town",
                ],
              },
            },
          ],
        });
      }),
    );
    const before = await billing.readBillingStatus(actor);
    const search = await billing.requestMapsSearch(
      actor,
      { query: "Find an all-night cafe in this small town" },
      [200],
    );
    expect(search.body).toMatchObject({
      sources: [],
      citations: [],
      billingQuantity: 28_100,
      creditsCharged: 36,
      usage: { mapsQueries: 2 },
    });
    expect(search.body).not.toHaveProperty("attribution");
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      before.credits - 36,
    );
  });

  it("prices cached prompt tokens separately and rounds combined token cost once", async () => {
    const { billing, actor } = await setupMaps();
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return vertexMapsResponse({ inputTokens: 101, cachedInputTokens: 81 });
      }),
    );
    const search = await billing.requestMapsSearch(
      actor,
      { query: "Coffee near Union Square" },
      [200],
    );
    // 20 * $0.25/M + 81 * $0.025/M + 50 * $1.50/M = 82.025 micro USD.
    expect(search.body).toMatchObject({
      billingQuantity: 14_083,
      providerCostUsd: 0.014083,
      creditsCharged: 18,
      usage: { inputTokens: 101, cachedInputTokens: 81, outputTokens: 50 },
    });
  });

  it.each([
    { name: "missing query list with sources", queries: undefined },
    { name: "null query list", queries: null },
    { name: "zero queries despite sources", queries: [] },
    { name: "non-string query", queries: [1] },
    { name: "blank query", queries: ["  "] },
  ])("does not charge for $name", async ({ queries }) => {
    const { billing, actor } = await setupMaps();
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return HttpResponse.json({
          ...validResponse,
          candidates: [
            {
              ...validCandidate,
              groundingMetadata: {
                ...validCandidate.groundingMetadata,
                retrievalQueries: queries,
              },
            },
          ],
        });
      }),
    );
    const before = await billing.readBillingStatus(actor);
    const search = await billing.requestMapsSearch(
      actor,
      { query: "Coffee near Union Square" },
      [502],
    );
    expect(search.body).toMatchObject({
      error: { code: "MAPS_USAGE_UNAVAILABLE" },
    });
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      before.credits,
    );
  });

  it.each([
    { name: "missing token usage", usage: undefined },
    {
      name: "negative tokens",
      usage: { ...validResponse.usageMetadata, promptTokenCount: -1 },
    },
    {
      name: "fractional tokens",
      usage: { ...validResponse.usageMetadata, candidatesTokenCount: 1.5 },
    },
    {
      name: "cached tokens exceeding input",
      usage: { ...validResponse.usageMetadata, cachedContentTokenCount: 101 },
    },
    {
      name: "output count overflow",
      usage: {
        ...validResponse.usageMetadata,
        candidatesTokenCount: Number.MAX_SAFE_INTEGER,
        thoughtsTokenCount: 1,
      },
    },
    {
      name: "cost overflow",
      usage: {
        ...validResponse.usageMetadata,
        candidatesTokenCount: Number.MAX_SAFE_INTEGER,
        thoughtsTokenCount: 0,
      },
    },
  ])("does not charge for $name", async ({ usage }) => {
    const { billing, actor } = await setupMaps();
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return HttpResponse.json({ ...validResponse, usageMetadata: usage });
      }),
    );
    const before = await billing.readBillingStatus(actor);
    const search = await billing.requestMapsSearch(
      actor,
      { query: "Coffee near Union Square" },
      [502],
    );
    expect(search.body).toMatchObject({
      error: { code: "MAPS_USAGE_UNAVAILABLE" },
    });
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      before.credits,
    );
  });

  it.each(["MAX_TOKENS", "SAFETY", "RECITATION", "OTHER"])(
    "rejects %s output without charging",
    async (finishReason) => {
      const { billing, actor } = await setupMaps();
      server.use(
        http.post(VERTEX_MAPS_URL, () => {
          return HttpResponse.json({
            ...validResponse,
            candidates: [{ ...validCandidate, finishReason }],
          });
        }),
      );
      const before = await billing.readBillingStatus(actor);
      const search = await billing.requestMapsSearch(
        actor,
        { query: "Coffee near Union Square" },
        [502],
      );
      expect(search.body).toMatchObject({
        error: {
          code:
            finishReason === "SAFETY" || finishReason === "RECITATION"
              ? "MAPS_GROUNDING_BLOCKED"
              : "MAPS_GROUNDING_ERROR",
        },
      });
      expect((await billing.readBillingStatus(actor)).credits).toBe(
        before.credits,
      );
    },
  );

  it("rejects an unexecuted native route function call observed in the live preview", async () => {
    const { billing, actor } = await setupMaps();
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return HttpResponse.json({
          ...validResponse,
          candidates: [
            {
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "route_lookup",
                      args: {
                        routes: [
                          {
                            travel_mode: "TRANSIT",
                            waypoints: ["Airport", "Station"],
                          },
                        ],
                      },
                    },
                    thoughtSignature: "private-signature",
                  },
                ],
              },
            },
          ],
        });
      }),
    );
    const before = await billing.readBillingStatus(actor);
    const search = await billing.requestMapsSearch(
      actor,
      { query: "Find a public transit route from the airport to the station" },
      [502],
    );
    expect(search.body).toMatchObject({
      error: { code: "MAPS_GROUNDING_ERROR" },
    });
    expect(JSON.stringify(search.body)).not.toContain("private-signature");
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      before.credits,
    );
  });

  it("rejects another model instead of applying Flash-Lite prices", async () => {
    const { billing, actor } = await setupMaps();
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return HttpResponse.json({
          ...validResponse,
          modelVersion: "gemini-3.8-flash",
        });
      }),
    );
    const before = await billing.readBillingStatus(actor);
    await billing.requestMapsSearch(
      actor,
      { query: "Coffee near Union Square" },
      [502],
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      before.credits,
    );
  });

  it("preserves provider source order and UTF-8 spans across parts without exposing thoughts", async () => {
    const { billing, actor } = await setupMaps();
    const prefix = "推荐：";
    const first = "北京咖啡";
    const second = "Café";
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return vertexMapsResponse({
          parts: [
            { text: "private reasoning", thought: true },
            { text: prefix },
            { text: first },
            { text: second },
          ],
          sources: [
            { title: "Café Central", uri: "https://maps.google.com/?cid=123" },
            { title: "北京咖啡", uri: "https://maps.google.com/?cid=456" },
          ],
          supports: [
            {
              partIndex: 2,
              endIndex: Buffer.byteLength(first),
              text: first,
              sourceIndices: [1],
            },
            {
              partIndex: 3,
              endIndex: Buffer.byteLength(second),
              text: second,
              sourceIndices: [0, 1],
            },
          ],
          mapsQueries: 3,
        });
      }),
    );
    const search = await billing.requestMapsSearch(
      actor,
      { query: "推荐咖啡馆", languageCode: "zh_CN" },
      [200],
    );
    expect(search.body).toMatchObject({
      answer: prefix + first + second,
      sources: [
        { title: "Café Central", uri: "https://maps.google.com/?cid=123" },
        { title: "北京咖啡", uri: "https://maps.google.com/?cid=456" },
      ],
      citations: [
        {
          startByte: Buffer.byteLength(prefix),
          endByte: Buffer.byteLength(prefix + first),
          text: first,
          sourceIndices: [1],
        },
        {
          startByte: Buffer.byteLength(prefix + first),
          endByte: Buffer.byteLength(prefix + first + second),
          text: second,
          sourceIndices: [0, 1],
        },
      ],
    });
    expect(JSON.stringify(search.body)).not.toContain("private");
  });

  it("charges only tokens for a clarification with no grounding metadata and sends no implicit location", async () => {
    const { billing, actor } = await setupMaps();
    let body: unknown;
    server.use(
      http.post(VERTEX_MAPS_URL, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          ...validResponse,
          candidates: [
            {
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [{ text: "Please provide a city or location." }],
              },
            },
          ],
        });
      }),
    );
    const search = await billing.requestMapsSearch(
      actor,
      { query: "Coffee near me" },
      [200],
    );
    expect(body).toMatchObject({
      tools: [{ googleMaps: { groundingTypes: { places: {}, routing: {} } } }],
    });
    expect(JSON.stringify(body)).not.toMatch(/latitude|longitude/u);
    expect(search.body).toMatchObject({
      answer: "Please provide a city or location.",
      sources: [],
      citations: [],
      usage: { mapsQueries: 0 },
      billingQuantity: 100,
      creditsCharged: 1,
    });
  });
});
