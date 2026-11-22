import { describe, expect, it } from "vitest";
import {
  presentationFormatContract,
  confirmPresentationFormatResponseSchema,
  resolvePresentationFormatResponseSchema,
} from "../presentation-format";

const sourceRunId = "c09c33a4-96f0-4502-bfb3-cd0102e452c3";
const threadId = "d10c33a4-96f0-4502-bfb3-cd0102e452c3";
const continuationEventId = "e11c33a4-96f0-5502-bfb3-cd0102e452c3";

describe("presentation format API contract", () => {
  it("accepts a narrow optional single-task request and rejects caller-owned source context", () => {
    expect(presentationFormatContract.resolve.body.parse({})).toStrictEqual({});
    expect(
      presentationFormatContract.resolve.body.parse({
        requestedFormat: "pptx",
      }),
    ).toStrictEqual({ requestedFormat: "pptx" });
    expect(
      presentationFormatContract.resolve.body.safeParse({
        sourceRunId,
        threadId,
      }).success,
    ).toBe(false);
    expect(
      presentationFormatContract.confirm.body.parse({
        sourceRunId,
        presentationFormat: "html",
      }),
    ).toStrictEqual({ sourceRunId, presentationFormat: "html" });
  });

  it("represents an inline card and an accepted input without implying generation completion", () => {
    const identity = {
      sourceRunId,
      threadId,
      continuationEventId,
      requestedFormat: null,
    };
    const selection = {
      status: "selection_required",
      ...identity,
      card: {
        type: "presentation_format_selection",
        ...identity,
        formats: ["html", "pptx"],
        action: { method: "POST", path: "/api/presentation-format/confirm" },
      },
    };
    expect(
      resolvePresentationFormatResponseSchema.parse(selection),
    ).toStrictEqual(selection);
    const accepted = {
      status: "accepted",
      sourceRunId,
      threadId,
      continuationEventId,
      presentationFormat: "pptx",
      acceptedAt: "2026-11-22T12:00:00.000Z",
    };
    expect(
      confirmPresentationFormatResponseSchema.parse(accepted),
    ).toStrictEqual(accepted);
  });
});
