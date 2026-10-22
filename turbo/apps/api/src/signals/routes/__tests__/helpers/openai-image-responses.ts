import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { z } from "zod";
import { server } from "../../../../mocks/server";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const submissionSchema = z.object({
  metadata: z.object({ generation_id: z.string().min(1) }),
});

export interface ImageResponseSubmission {
  readonly id: string;
  readonly generationId: string;
  readonly body: unknown;
}

/** Provider-owned HTTP fixtures, with identities copied from the actual POST. */
export function mockOpenAiImageResponses(
  options: {
    readonly submit?: (submission: ImageResponseSubmission) => Response;
  } = {},
) {
  const submissions: ImageResponseSubmission[] = [];
  const retrievals: string[] = [];
  const responses = new Map<string, Record<string, unknown>>();
  server.use(
    http.post(OPENAI_RESPONSES_URL, async ({ request }) => {
      const body: unknown = await request.json();
      const { metadata } = submissionSchema.parse(body);
      const submission = {
        id: `resp_${randomUUID()}`,
        generationId: metadata.generation_id,
        body,
      };
      submissions.push(submission);
      const response = {
        id: submission.id,
        status: "queued",
        metadata,
        output: [],
        usage: null,
      };
      responses.set(submission.id, response);
      return options.submit?.(submission) ?? HttpResponse.json(response);
    }),
    http.get(`${OPENAI_RESPONSES_URL}/:responseId`, ({ params }) => {
      const id = String(params.responseId);
      retrievals.push(id);
      const response = responses.get(id);
      return response
        ? HttpResponse.json(response)
        : HttpResponse.json({ error: { code: "not_found" } }, { status: 404 });
    }),
  );
  function submission() {
    const value = submissions[0];
    if (!value) {
      throw new Error("Expected a Responses image submission");
    }
    return value;
  }
  return { submissions, retrievals, responses, submission };
}

/** No invented image-tool usage: only the documented mainline usage is present. */
export function completedImageResponseWithoutUsage(
  submission: ImageResponseSubmission,
) {
  return {
    id: submission.id,
    status: "completed",
    metadata: { generation_id: submission.generationId },
    output: [
      {
        type: "image_generation_call",
        id: `ig_${submission.id}`,
        status: "completed",
        result: Buffer.from("generated image bytes").toString("base64"),
        action: "generate",
        background: "opaque",
        output_format: "png",
        quality: "medium",
        size: "1024x1024",
        revised_prompt: "A private revised prompt",
      },
    ],
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 30,
      total_tokens: 150,
    },
  };
}
