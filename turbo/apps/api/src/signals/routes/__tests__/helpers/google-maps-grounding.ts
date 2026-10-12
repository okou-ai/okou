import { HttpResponse } from "msw";

import { mockGoogleLlm } from "./google-voice";

export const VERTEX_MAPS_URL =
  /^https:\/\/aiplatform\.googleapis\.com\/v1beta1\/projects\/[^/]+\/locations\/global\/publishers\/google\/models\/gemini-3\.1-flash-lite:generateContent$/u;

interface GroundingSource {
  readonly title: string;
  readonly uri: string;
}

interface GroundingSupport {
  readonly partIndex?: number;
  readonly startIndex?: number;
  readonly endIndex: number;
  readonly text?: string;
  readonly sourceIndices: readonly number[];
}

interface VertexMapsResponseOptions {
  readonly answer?: string;
  readonly parts?: readonly {
    readonly text: string;
    readonly thought?: boolean;
  }[];
  readonly sources?: readonly GroundingSource[];
  readonly supports?: readonly GroundingSupport[];
  readonly mapsQueries?: number;
  readonly cachedInputTokens?: number;
  readonly inputTokens?: number;
  readonly candidateTokens?: number;
  readonly thoughtTokens?: number;
}

export function vertexMapsContent(options: VertexMapsResponseOptions = {}) {
  const answer = options.answer ?? "Café Central is open nearby.";
  const mapsQueries = options.mapsQueries ?? 1;
  const sources =
    options.sources ??
    (mapsQueries === 0
      ? []
      : ([
          {
            title: "Café Central",
            uri: "https://maps.google.com/?cid=123",
          },
        ] as const));
  const supports =
    options.supports ??
    (mapsQueries === 0
      ? []
      : ([
          {
            startIndex: 0,
            endIndex: Buffer.byteLength(answer),
            text: answer,
            sourceIndices: [0],
          },
        ] as const));
  return {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: options.parts ?? [{ text: answer }],
        },
        groundingMetadata: {
          retrievalQueries: Array.from({ length: mapsQueries }, (_, index) => {
            return `coffee query ${index}`;
          }),
          groundingChunks: sources.map((source) => {
            return { maps: source };
          }),
          groundingSupports: supports.map((support) => {
            return {
              segment: {
                ...(support.partIndex === undefined
                  ? {}
                  : { partIndex: support.partIndex }),
                ...(support.startIndex === undefined
                  ? {}
                  : { startIndex: support.startIndex }),
                endIndex: support.endIndex,
                ...(support.text === undefined ? {} : { text: support.text }),
              },
              groundingChunkIndices: [...support.sourceIndices],
            };
          }),
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: options.inputTokens ?? 100,
      cachedContentTokenCount: options.cachedInputTokens ?? 0,
      candidatesTokenCount: options.candidateTokens ?? 40,
      thoughtsTokenCount: options.thoughtTokens ?? 10,
      // Maps-provided tool input is reported separately and is not billable.
      toolUsePromptTokenCount: 999,
      totalTokenCount:
        (options.inputTokens ?? 100) +
        (options.candidateTokens ?? 40) +
        (options.thoughtTokens ?? 10) +
        999,
    },
    modelVersion: "gemini-3.1-flash-lite",
  };
}

export function vertexMapsResponse(options: VertexMapsResponseOptions = {}) {
  return HttpResponse.json(vertexMapsContent(options));
}

export function mockGoogleMapsGrounding() {
  return mockGoogleLlm("maps");
}
