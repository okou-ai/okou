import { HttpResponse } from "msw";
import { onTestFinished } from "vitest";
import { z } from "zod";

import { stubTestVercelRuntimeToken } from "../../../../__tests__/env-stub";
import { mockGoogleLlm } from "./google-voice";

export const VERTEX_TEXT_URL =
  /^https:\/\/aiplatform\.us\.rep\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/us\/publishers\/google\/models\/(gemini-3\.1-flash-lite|gemini-3\.8-flash):generateContent$/u;

export const vertexTextRequestSchema = z.object({
  systemInstruction: z.object({
    parts: z.array(z.object({ text: z.string() })),
  }),
  contents: z.array(
    z.object({
      role: z.enum(["user", "model"]),
      parts: z.array(z.object({ text: z.string() })),
    }),
  ),
  generationConfig: z.object({
    maxOutputTokens: z.number().int().positive(),
    temperature: z.number().optional(),
    thinkingConfig: z.object({ thinkingLevel: z.enum(["MINIMAL", "LOW"]) }),
    responseMimeType: z.literal("application/json").optional(),
    responseJsonSchema: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Native wire fields plus flattened prompts for business-fixture dispatch. */
export function vertexTextRequest(value: unknown, url: string) {
  const body = vertexTextRequestSchema.parse(value);
  const model = VERTEX_TEXT_URL.exec(url)?.[1];
  if (!model) {
    throw new Error("Unexpected Vertex text model URL");
  }
  return {
    ...body,
    model,
    messages: [
      ...body.systemInstruction.parts.map((part) => {
        return {
          role: "system",
          content: part.text,
        };
      }),
      ...body.contents.map((entry) => {
        return {
          role: entry.role === "model" ? "assistant" : "user",
          content: entry.parts
            .map((part) => {
              return part.text;
            })
            .join(""),
        };
      }),
    ],
  };
}

export function vertexTextResponse(text: string, finishReason = "STOP") {
  return HttpResponse.json({
    candidates: [
      { finishReason, content: { role: "model", parts: [{ text }] } },
    ],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 60,
      thoughtsTokenCount: 10,
    },
  });
}

export function mockGoogleText() {
  onTestFinished(() => {
    return stubTestVercelRuntimeToken(undefined);
  });
  return mockGoogleLlm("text");
}
