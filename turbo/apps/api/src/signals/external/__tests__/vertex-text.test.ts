import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../mocks/server";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
  vertexTextResponse,
} from "../../routes/__tests__/helpers/google-text";
import { VERTEX_FOLLOWUP_MODEL, VERTEX_TEXT_MODEL } from "../vertex-models";
import { generateVertexTextWithUsage } from "../vertex-text";

const messages = [
  { role: "system", content: "Write only the answer" },
  { role: "user", content: "Summarize the launch" },
] as const;

describe("native Vertex text contract", () => {
  it.each([
    { model: VERTEX_TEXT_MODEL, thinking: "MINIMAL", temperature: 0.4 },
    { model: VERTEX_FOLLOWUP_MODEL, thinking: "LOW", temperature: undefined },
  ] as const)("uses the native controls for $model", async (expected) => {
    mockGoogleText();
    let requests = 0;
    server.use(
      http.post(VERTEX_TEXT_URL, async ({ request }) => {
        requests++;
        const body = vertexTextRequest(await request.json(), request.url);
        expect(request.headers.get("authorization")).toBe(
          "Bearer synthetic-google-token",
        );
        expect(body.model).toBe(expected.model.replace("google/", ""));
        expect(body.generationConfig).toStrictEqual({
          thinkingConfig: { thinkingLevel: expected.thinking },
          maxOutputTokens: 2048,
          ...(expected.temperature === undefined
            ? {}
            : { temperature: expected.temperature }),
        });
        expect(body.messages).toStrictEqual(messages);
        return vertexTextResponse(" Ready to launch ");
      }),
    );
    await expect(
      generateVertexTextWithUsage(expected.model, messages, 2048, {
        temperature: 0.4,
      }),
    ).resolves.toMatchObject({ text: "Ready to launch", truncated: false });
    expect(requests).toBe(1);
  });

  it.each([true, false])(
    "requires caller opt-in to truncated output (%s)",
    async (acceptTruncatedText) => {
      mockGoogleText();
      server.use(
        http.post(VERTEX_TEXT_URL, () => {
          return HttpResponse.json({
            candidates: [
              {
                finishReason: "MAX_TOKENS",
                content: {
                  parts: [
                    { text: "private thought", thought: true },
                    { text: " Usable summary " },
                  ],
                },
              },
            ],
            usageMetadata: { candidatesTokenCount: 7, thoughtsTokenCount: 11 },
          });
        }),
      );
      const result = generateVertexTextWithUsage(
        VERTEX_TEXT_MODEL,
        messages,
        2048,
        { acceptTruncatedText },
      );
      if (acceptTruncatedText) {
        await expect(result).resolves.toStrictEqual({
          text: "Usable summary",
          truncated: true,
          tokens: { completionTokens: 7, reasoningTokens: 11 },
        });
      } else {
        await expect(result).rejects.toMatchObject({
          reason: "output_truncated",
          tokens: { completionTokens: 7, reasoningTokens: 11 },
        });
      }
    },
  );

  it.each(["before request", "during request"])(
    "preserves the caller's abort identity %s",
    async (timing) => {
      mockGoogleText();
      const controller = new AbortController();
      const reason = new Error("Owner ended");
      let requests = 0;
      server.use(
        http.post(VERTEX_TEXT_URL, () => {
          requests++;
          controller.abort(reason);
          return vertexTextResponse("Must not become visible");
        }),
      );
      if (timing === "before request") {
        controller.abort(reason);
      }
      await expect(
        generateVertexTextWithUsage(
          VERTEX_TEXT_MODEL,
          messages,
          2048,
          {},
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(requests).toBe(timing === "before request" ? 0 : 1);
    },
  );
});
