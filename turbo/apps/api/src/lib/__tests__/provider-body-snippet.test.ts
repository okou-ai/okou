import { describe, expect, it } from "vitest";

import { providerBodySnippet } from "../provider-body-snippet";

describe("providerBodySnippet", () => {
  it("collapses a gateway error page onto one readable line", () => {
    const body =
      "<html>\n  <head><title>502 Bad Gateway</title></head>\n</html>";

    expect(providerBodySnippet(body)).toBe(
      "<html> <head><title>502 Bad Gateway</title></head> </html>",
    );
  });

  it("bounds a long body instead of carrying the whole document", () => {
    const snippet = providerBodySnippet("upstream connect error. ".repeat(50));

    // The retained slice plus its truncation mark, never the whole document.
    expect(snippet).toHaveLength(201);
    expect(snippet).toMatch(/^upstream connect error\..*…$/su);
  });

  it("redacts a presigned URL the provider echoed back", () => {
    const body =
      "rejected https://r2.example.com/a.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=signature";

    expect(providerBodySnippet(body)).toBe("rejected [redacted presigned URL]");
  });

  it("reports nothing for a blank body", () => {
    expect(providerBodySnippet("   \n\t  ")).toBeUndefined();
  });
});
