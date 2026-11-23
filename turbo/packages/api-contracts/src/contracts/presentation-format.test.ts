import { describe, expect, it } from "vitest";

import { presentationFormatContract } from "./presentation-format";
import { validateResponse } from "./trpc-contract";

describe("Presentation format responses", () => {
  it.each(["html", "pptx", null] as const)(
    "returns the presentation preference %s without a default",
    (presentationFormat) => {
      const body = { presentationFormat };
      const response = validateResponse({
        appRoute: presentationFormatContract.get,
        response: { status: 200, body },
      });

      expect(response.body).toStrictEqual(body);
    },
  );

  it("requires an explicit null when no format has been chosen", () => {
    expect(() => {
      validateResponse({
        appRoute: presentationFormatContract.get,
        response: { status: 200, body: {} },
      });
    }).toThrow("Response validation failed");
  });
});
