import { HttpResponse } from "msw";

import { mockGoogleLlm } from "./google-voice";

export const VERTEX_MAPS_URL =
  /^https:\/\/aiplatform\.googleapis\.com\/v1beta1\/projects\/[^/]+\/locations\/global\/publishers\/google\/models\/gemini-2\.5-flash:generateContent$/u;

interface GroundingSource {
  readonly title: string;
  readonly uri: string;
}

interface GroundingSupport {
  readonly startIndex?: number;
  readonly endIndex: number;
  readonly text?: string;
  readonly sourceIndices: readonly number[];
}

interface VertexMapsResponseOptions {
  readonly answer?: string;
  readonly sources?: readonly GroundingSource[];
  readonly supports?: readonly GroundingSupport[];
  readonly inputTokens?: number;
  readonly candidateTokens?: number;
  readonly thoughtTokens?: number;
}

export function vertexMapsResponse(options: VertexMapsResponseOptions = {}) {
  const answer = options.answer ?? "Café Central is open nearby.";
  const sources =
    options.sources ??
    ([
      {
        title: "Café Central",
        uri: "https://maps.google.com/?cid=123",
      },
    ] as const);
  const supports =
    options.supports ??
    ([
      {
        startIndex: 0,
        endIndex: Buffer.byteLength(answer),
        text: answer,
        sourceIndices: [0],
      },
    ] as const);
  return HttpResponse.json({
    candidates: [
      {
        finishReason: "STOP",
        content: { role: "model", parts: [{ text: answer }] },
        groundingMetadata: {
          groundingChunks: sources.map((source) => {
            return { maps: source };
          }),
          groundingSupports: supports.map((support) => {
            return {
              segment: {
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
    modelVersion: "gemini-2.5-flash",
  });
}

export function mockGoogleMapsGrounding() {
  return mockGoogleLlm("maps");
}
