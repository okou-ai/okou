import { HttpResponse } from "msw";

import { mockGoogleLlm } from "./google-voice";

export const VERTEX_MAPS_URL =
  /^https:\/\/aiplatform\.googleapis\.com\/v1beta1\/projects\/[^/]+\/locations\/global\/interactions$/u;

interface PlaceCitation {
  readonly type: "place_citation";
  readonly name: string;
  readonly url: string;
  readonly start_index?: number;
  readonly end_index?: number;
}

interface TextContent {
  readonly type: "text";
  readonly text: string;
  readonly annotations?: readonly PlaceCitation[];
}

interface VertexMapsResponseOptions {
  readonly answer?: string;
  readonly content?: readonly TextContent[];
  readonly mapsQueries?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly thoughtTokens?: number;
}

export function vertexMapsInteraction(options: VertexMapsResponseOptions = {}) {
  const answer = options.answer ?? "Café Central is open nearby.";
  const mapsQueries = options.mapsQueries ?? 1;
  return {
    id: "maps-interaction",
    model: "gemini-3.5-flash-lite",
    status: "completed",
    steps: [
      { type: "thought", signature: "private-reasoning-signature" },
      ...(mapsQueries === 0
        ? []
        : [
            {
              type: "google_maps_call",
              id: "maps-call",
              arguments: { queries: ["coffee in Vienna"] },
            },
            {
              type: "google_maps_result",
              call_id: "maps-call",
              result: [
                {
                  places: [
                    {
                      name: "Café Central",
                      url: "https://maps.google.com/?cid=123",
                      place_id: "places/123",
                    },
                  ],
                },
              ],
            },
          ]),
      {
        type: "model_output",
        content: options.content ?? [
          {
            type: "text",
            text: answer,
            annotations:
              mapsQueries === 0
                ? []
                : [
                    {
                      type: "place_citation",
                      name: "Café Central",
                      url: "https://maps.google.com/?cid=123",
                      start_index: 0,
                      end_index: Buffer.byteLength(answer),
                    },
                  ],
          },
        ],
      },
    ],
    usage: {
      total_input_tokens: options.inputTokens ?? 100,
      total_cached_tokens: options.cachedInputTokens ?? 0,
      total_output_tokens: options.outputTokens ?? 40,
      total_thought_tokens: options.thoughtTokens ?? 10,
      // Maps-provided tool input is reported separately and is not billable.
      total_tool_use_tokens: 999,
      grounding_tool_count: [{ type: "google_maps", count: mapsQueries }],
    },
  };
}

export function vertexMapsResponse(options: VertexMapsResponseOptions = {}) {
  return HttpResponse.json(vertexMapsInteraction(options));
}

export function mockGoogleMapsGrounding() {
  return mockGoogleLlm("maps");
}
