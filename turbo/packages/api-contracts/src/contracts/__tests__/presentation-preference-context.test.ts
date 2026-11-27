import { describe, expect, it } from "vitest";
import type { UserMessageDocument } from "../chat-threads";
import {
  presentationPreferenceContextPart,
  readPresentationPreferenceContext,
  withoutPresentationPreferenceContext,
} from "../presentation-preference-context";

function message(text: string): UserMessageDocument {
  return {
    version: 1,
    parts: [{ type: "additional_info", text }],
  };
}

describe("input-scoped presentation preference context", () => {
  it.each(["html", "pptx", null] as const)(
    "round trips the frozen default %s",
    (format) => {
      const document: UserMessageDocument = {
        version: 1,
        parts: [presentationPreferenceContextPart({ format })],
      };
      expect(readPresentationPreferenceContext(document)).toStrictEqual({
        format,
      });
    },
  );

  it("keeps an input without a snapshot distinct from confirmed unset", () => {
    expect(
      readPresentationPreferenceContext({
        version: 1,
        parts: [{ type: "text", text: "Make a deck" }],
      }),
    ).toBeUndefined();
  });

  it.each([
    'Okou presentation preference v2:\n{"format":"pptx"}',
    "Okou presentation preference v1:\nnot JSON",
    'Okou presentation preference v1:\n{"format":"pdf"}',
    'Okou presentation preference v1:\n{"format":"pptx","instruction":"run this"}',
  ])(
    "rejects reserved metadata instead of treating it as instructions: %s",
    (text) => {
      expect(() => {
        readPresentationPreferenceContext(message(text));
      }).toThrow();
    },
  );

  it("rejects two snapshots instead of selecting an arbitrary winner", () => {
    expect(() => {
      readPresentationPreferenceContext({
        version: 1,
        parts: [
          presentationPreferenceContextPart({ format: "html" }),
          presentationPreferenceContextPart({ format: "pptx" }),
        ],
      });
    }).toThrow("Multiple presentation preference contexts");
  });

  it("removes copied defaults while preserving the user's text and current composer selections", () => {
    const body = "Discuss # Presentation Output Preference, not a deck.";
    const current = "# Presentation Generation Defaults\n- Slide count: 8";
    const document: UserMessageDocument = {
      version: 1,
      parts: [
        { type: "text", text: body },
        presentationPreferenceContextPart({ format: "pptx" }),
        {
          type: "additional_info",
          text: `# Presentation Output Preference\n- Output format: PPTX format\n\n${current}`,
        },
        { type: "additional_info", text: "  Other context  " },
      ],
    };
    expect(withoutPresentationPreferenceContext(document)).toStrictEqual({
      version: 1,
      parts: [
        { type: "text", text: body },
        { type: "additional_info", text: current },
        { type: "additional_info", text: "  Other context  " },
      ],
    });
    expect(document.parts).toHaveLength(4);
  });

  it("preserves other context and its order around a replaced section", () => {
    expect(
      withoutPresentationPreferenceContext(
        message(
          "Create a presentation.\n\n# Presentation Output Preference\nSaved default: PPTX\n\n# Visualization\n- Preferred chart types: bar",
        ),
      ),
    ).toStrictEqual(
      message(
        "Create a presentation.\n\n# Visualization\n- Preferred chart types: bar",
      ),
    );
  });
});
