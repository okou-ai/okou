import { describe, expect, it } from "vitest";

import { convertsToGoogleSlides } from "../google-slides-conversion";

describe("convertsToGoogleSlides", () => {
  it("accepts the OOXML presentation family", () => {
    expect(
      [
        "deck.pptx",
        "deck.pptm",
        "template.potx",
        "template.potm",
        "show.ppsx",
        "show.ppsm",
      ].map(convertsToGoogleSlides),
    ).toStrictEqual([true, true, true, true, true, true]);
  });

  it("rejects the legacy binary presentation family", () => {
    // Drive answers HTTP 200 for these and returns a deck with no page
    // elements, so offering the conversion would sync a blank presentation.
    expect(
      ["deck.ppt", "show.pps", "template.pot"].map(convertsToGoogleSlides),
    ).toStrictEqual([false, false, false]);
  });

  it("rejects artifacts that are not presentations", () => {
    expect(
      ["report.docx", "data.xlsx", "deck.odp", "deck.pdf", "archive.zip"].map(
        convertsToGoogleSlides,
      ),
    ).toStrictEqual([false, false, false, false, false]);
  });

  it("ignores case and URL suffixes around the extension", () => {
    expect(convertsToGoogleSlides("Deck.PPTX")).toBe(true);
    expect(convertsToGoogleSlides("/artifacts/abc.pptx?download=1")).toBe(true);
    expect(convertsToGoogleSlides("/artifacts/abc.pptx#page=2")).toBe(true);
  });

  it("rejects names that carry no extension", () => {
    expect(convertsToGoogleSlides("pptx")).toBe(false);
    expect(convertsToGoogleSlides("deck")).toBe(false);
    expect(convertsToGoogleSlides("")).toBe(false);
  });
});
