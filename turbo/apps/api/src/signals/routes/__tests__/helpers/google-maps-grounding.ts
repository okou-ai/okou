import { HttpResponse } from "msw";

import { mockGoogleLlm } from "./google-voice";

export const VERTEX_MAPS_URL =
  /^https:\/\/aiplatform\.googleapis\.com\/v1beta1\/projects\/[^/]+\/locations\/global\/interactions:create$/u;

interface PlaceCitation {
  readonly placeCitation: { readonly name: string; readonly url: string };
  readonly startIndex?: number;
  readonly endIndex?: number;
}

interface TextContent {
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
  const content = options.content ?? [
    {
      text: answer,
      annotations:
        mapsQueries === 0
          ? []
          : [
              {
                placeCitation: {
                  name: "Café Central",
                  url: "https://maps.google.com/?cid=123",
                },
                startIndex: 0,
                endIndex: Buffer.byteLength(answer),
              },
            ],
    },
  ];
  return {
    id: "maps-interaction",
    modelInteraction: { model: "gemini-3.5-flash-lite" },
    status: "COMPLETED",
    steps: [
      { thought: { signature: "private-reasoning-signature" } },
      ...(mapsQueries === 0
        ? []
        : [
            {
              toolCall: {
                id: "maps-call",
                googleMapsCall: {
                  arguments: { queries: ["coffee in Vienna"] },
                },
              },
            },
            {
              toolResult: {
                callId: "maps-call",
                googleMapsResult: {
                  result: [
                    {
                      places: [
                        {
                          name: "Café Central",
                          url: "https://maps.google.com/?cid=123",
                          placeId: "places/123",
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ]),
      {
        modelOutput: {
          content: content.map((text) => {
            return { text };
          }),
        },
      },
    ],
    usage: {
      totalInputTokens: options.inputTokens ?? 100,
      totalCachedTokens: options.cachedInputTokens ?? 0,
      totalOutputTokens: options.outputTokens ?? 40,
      totalThoughtTokens: options.thoughtTokens ?? 10,
      // Maps-provided tool input is reported separately and is not billable.
      totalToolUseTokens: 999,
      groundingToolCount: [{ type: "GOOGLE_MAPS", count: mapsQueries }],
    },
  };
}

export function vertexMapsResponse(options: VertexMapsResponseOptions = {}) {
  return HttpResponse.json(vertexMapsInteraction(options));
}

export function mockGoogleMapsGrounding() {
  return mockGoogleLlm("maps");
}
