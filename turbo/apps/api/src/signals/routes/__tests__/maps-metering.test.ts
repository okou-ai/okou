import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createBddApi } from "./helpers/api-bdd";
import { createMapsBillingApi } from "./helpers/api-bdd-maps-billing";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  VERTEX_MAPS_URL,
  vertexMapsInteraction,
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

const validUsage = vertexMapsInteraction().usage;

describe("Maps Interactions usage and citations", () => {
  it("does not charge for the incomplete citation and usage shape returned by live Vertex", async () => {
    const { billing, actor } = await setupMaps();
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        // Reduced, anonymized response observed on the pinned Vertex revision.
        // The place exists only in the tool result: annotations have no source
        // identity, and usage has no billable Maps query aggregate.
        return HttpResponse.json({
          model: "gemini-3.8-flash",
          status: "completed",
          steps: [
            { type: "thought", signature: "private-signature" },
            {
              type: "model_output",
              content: [
                {
                  type: "text",
                  text: "Example Cafe is open nearby.",
                  annotations: [{ start_index: 0, end_index: 18 }],
                },
              ],
            },
            { type: "google_maps_call", id: "maps-call" },
            {
              type: "google_maps_result",
              call_id: "maps-call",
              result: [
                {
                  places: [
                    {
                      place_id: "places/123",
                      name: "Example Cafe",
                      url: "https://maps.google.com/?cid=123",
                    },
                  ],
                },
              ],
            },
          ],
          usage: {
            total_input_tokens: 199,
            total_output_tokens: 228,
            total_thought_tokens: 0,
            total_tool_use_tokens: 0,
            total_tokens: 427,
          },
        });
      }),
    );
    const before = await billing.readBillingStatus(actor);
    const search = await billing.requestMapsSearch(
      actor,
      { query: "Find one cafe near the Ferry Building in San Francisco" },
      [502],
    );
    expect(search.body).toMatchObject({
      error: { code: "MAPS_GROUNDING_ERROR" },
    });
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      before.credits,
    );
  });

  it.each([
    { mapsQueries: 0, providerCost: 525, credits: 1 },
    { mapsQueries: 3, providerCost: 42_525, credits: 54 },
    { mapsQueries: 4, providerCost: 56_525, credits: 71 },
  ])(
    "bills $mapsQueries provider queries even when their cost exceeds the admission estimate",
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

  it("charges executed Maps queries even when the answer has no place citations", async () => {
    const { billing, actor } = await setupMaps();
    const answer = "No matching places were found.";
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return vertexMapsResponse({
          mapsQueries: 2,
          content: [{ type: "text", text: answer }],
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
      answer,
      sources: [],
      citations: [],
      billingQuantity: 28_525,
      creditsCharged: 36,
      usage: { mapsQueries: 2 },
    });
    expect(search.body).not.toHaveProperty("attribution");
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      before.credits - 36,
    );
  });

  it("prices cached prompt tokens separately and rounds the combined token cost once", async () => {
    const { billing, actor } = await setupMaps();
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return vertexMapsResponse({ cachedInputTokens: 79 });
      }),
    );
    const search = await billing.requestMapsSearch(
      actor,
      { query: "Coffee near Union Square" },
      [200],
    );
    // 21 * $1.50/M + 79 * $0.15/M + 50 * $7.50/M = 418.35 micro USD.
    expect(search.body).toMatchObject({
      billingQuantity: 14_419,
      providerCostUsd: 0.014419,
      creditsCharged: 19,
      usage: { inputTokens: 100, cachedInputTokens: 79, outputTokens: 50 },
    });
  });

  it.each([
    { name: "missing usage", usage: undefined },
    {
      name: "missing query telemetry",
      usage: { ...validUsage, grounding_tool_count: undefined },
    },
    {
      name: "missing Maps entry",
      usage: { ...validUsage, grounding_tool_count: [] },
    },
    {
      name: "duplicate Maps counts",
      usage: {
        ...validUsage,
        grounding_tool_count: [
          { type: "google_maps", count: 1 },
          { type: "google_maps", count: 2 },
        ],
      },
    },
    {
      name: "negative count",
      usage: {
        ...validUsage,
        grounding_tool_count: [{ type: "google_maps", count: -1 }],
      },
    },
    {
      name: "fractional count",
      usage: {
        ...validUsage,
        grounding_tool_count: [{ type: "google_maps", count: 1.5 }],
      },
    },
    {
      name: "zero count despite Maps activity",
      usage: {
        ...validUsage,
        grounding_tool_count: [{ type: "google_maps", count: 0 }],
      },
    },
    {
      name: "unexpected billed tool",
      usage: {
        ...validUsage,
        grounding_tool_count: [
          { type: "google_maps", count: 1 },
          { type: "google_search", count: 2 },
        ],
      },
    },
    {
      name: "cached count larger than the prompt",
      usage: { ...validUsage, total_cached_tokens: 101 },
    },
    {
      name: "unrepresentable output token total",
      usage: { ...validUsage, total_output_tokens: Number.MAX_SAFE_INTEGER },
    },
    {
      name: "unrepresentable provider cost",
      usage: {
        ...validUsage,
        grounding_tool_count: [
          { type: "google_maps", count: Number.MAX_SAFE_INTEGER },
        ],
      },
    },
  ])(
    "rejects $name without settling an estimated charge",
    async ({ usage }) => {
      const { billing, actor } = await setupMaps();
      server.use(
        http.post(VERTEX_MAPS_URL, () => {
          return HttpResponse.json({ ...vertexMapsInteraction(), usage });
        }),
      );
      const before = await billing.readBillingStatus(actor);
      const search = await billing.requestMapsSearch(
        actor,
        { query: "Coffee near Union Square" },
        [502],
      );
      expect(search.body).toStrictEqual({
        error: {
          code: "MAPS_USAGE_UNAVAILABLE",
          message: "Google Maps grounding did not return valid billing usage",
        },
      });
      expect((await billing.readBillingStatus(actor)).credits).toBe(
        before.credits,
      );
    },
  );

  it.each(["failed", "incomplete", "requires_action", "in_progress"])(
    "rejects a %s interaction instead of returning partial output",
    async (status) => {
      const { billing, actor } = await setupMaps();
      server.use(
        http.post(VERTEX_MAPS_URL, () => {
          return HttpResponse.json({ ...vertexMapsInteraction(), status });
        }),
      );
      const before = await billing.readBillingStatus(actor);
      const search = await billing.requestMapsSearch(
        actor,
        { query: "Coffee near Union Square" },
        [502],
      );
      expect(search.body).toMatchObject({
        error: { code: "MAPS_GROUNDING_ERROR" },
      });
      expect((await billing.readBillingStatus(actor)).credits).toBe(
        before.credits,
      );
    },
  );

  it("rejects reported provider errors even alongside completed output", async () => {
    const { billing, actor } = await setupMaps();
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return HttpResponse.json({
          ...vertexMapsInteraction(),
          errors: [
            { code: "provider-fault", message: "private-provider-detail" },
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
      error: { code: "MAPS_GROUNDING_ERROR" },
    });
    expect(JSON.stringify(search.body)).not.toContain(
      "private-provider-detail",
    );
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      before.credits,
    );
  });

  it("rejects a different provider model instead of applying Flash-Lite prices to it", async () => {
    const { billing, actor } = await setupMaps();
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return HttpResponse.json({
          ...vertexMapsInteraction(),
          model: "gemini-3.8-flash",
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
      error: { code: "MAPS_GROUNDING_ERROR" },
    });
    expect((await billing.readBillingStatus(actor)).credits).toBe(
      before.credits,
    );
  });

  it("preserves source order and UTF-8 spans across output steps without exposing thoughts", async () => {
    const { billing, actor } = await setupMaps();
    const prefix = "推荐：";
    const first = "北京咖啡";
    const second = "Café";
    const firstSource = {
      type: "place_citation" as const,
      name: "北京咖啡",
      url: "https://maps.google.com/?cid=456",
      end_index: Buffer.byteLength(first),
    };
    server.use(
      http.post(VERTEX_MAPS_URL, () => {
        return HttpResponse.json({
          ...vertexMapsInteraction({ mapsQueries: 3 }),
          steps: [
            {
              type: "thought",
              signature: "private-signature",
              summary: [{ type: "text", text: "private reasoning" }],
            },
            {
              type: "model_output",
              content: [
                { type: "text", text: prefix },
                { type: "text", text: first, annotations: [firstSource] },
              ],
            },
            {
              type: "model_output",
              content: [
                {
                  type: "text",
                  text: second,
                  annotations: [
                    {
                      type: "place_citation",
                      name: "Café Central",
                      url: "https://maps.google.com/?cid=123",
                      start_index: 0,
                      end_index: Buffer.byteLength(second),
                    },
                  ],
                },
                { type: "text", text: first, annotations: [firstSource] },
              ],
            },
          ],
        });
      }),
    );
    const search = await billing.requestMapsSearch(
      actor,
      { query: "推荐咖啡馆", languageCode: "zh_CN" },
      [200],
    );
    expect(search.body).toMatchObject({
      answer: prefix + first + second + first,
      sources: [
        { title: "北京咖啡", uri: "https://maps.google.com/?cid=456" },
        { title: "Café Central", uri: "https://maps.google.com/?cid=123" },
      ],
      citations: [
        {
          startByte: Buffer.byteLength(prefix),
          endByte: Buffer.byteLength(prefix + first),
          text: first,
          sourceIndices: [0],
        },
        {
          startByte: Buffer.byteLength(prefix + first),
          endByte: Buffer.byteLength(prefix + first + second),
          text: second,
          sourceIndices: [1],
        },
        {
          startByte: Buffer.byteLength(prefix + first + second),
          endByte: Buffer.byteLength(prefix + first + second + first),
          text: first,
          sourceIndices: [0],
        },
      ],
    });
    expect(JSON.stringify(search.body)).not.toContain("private");
  });

  it("sends no implicit location when only the query was supplied", async () => {
    const { billing, actor } = await setupMaps();
    let body: unknown;
    server.use(
      http.post(VERTEX_MAPS_URL, async ({ request }) => {
        body = await request.json();
        return vertexMapsResponse({
          mapsQueries: 0,
          answer: "Please provide a city or location.",
        });
      }),
    );
    const search = await billing.requestMapsSearch(
      actor,
      { query: "Coffee near me" },
      [200],
    );
    expect(body).toMatchObject({ tools: [{ type: "google_maps" }] });
    expect(JSON.stringify(body)).not.toMatch(/latitude|longitude/u);
    expect(search.body).toMatchObject({
      answer: "Please provide a city or location.",
      sources: [],
      usage: { mapsQueries: 0 },
    });
  });
});
