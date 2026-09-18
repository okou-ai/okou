/* eslint-disable no-restricted-syntax -- #35074 independently proves the renderer's exact 32 KiB input/output behavior and first over-bound rejection. The production S5 -> delivery -> outbox -> renderer route reaches the same admitted ceiling in morning-brief-delivery.test.ts. */
import { describe, expect, it } from "vitest";

import {
  MORNING_BRIEF_RESULT_EMAIL_BODY_MAX_BYTES,
  MorningBriefResultEmailRenderError,
  renderMorningBriefResultEmail,
} from "../morning-brief-result-email-renderer";

function exactBoundaryMarkdown(): string {
  const prefix = [
    "# Exact 32 KiB boundary",
    "",
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(2)>",
    "[unsafe](javascript:alert(3))",
    "[safe](https://example.test/source?a=1&b=2)",
    "café 漢字 & **bold**",
    "",
  ].join("\n");
  const suffix = "\n\nEND-OF-ACCEPTED-BODY";
  const remaining =
    MORNING_BRIEF_RESULT_EMAIL_BODY_MAX_BYTES -
    Buffer.byteLength(prefix, "utf8") -
    Buffer.byteLength(suffix, "utf8");
  if (remaining <= 0) {
    throw new Error("Boundary fixture prefix is unexpectedly too large");
  }
  return `${prefix}${"x".repeat(remaining)}${suffix}`;
}

function renderProps(resultMarkdown: string) {
  return {
    title: "Morning Brief boundary",
    threadUrl: "https://app.okou.test/chats/thread-1",
    manageUrl: "https://app.okou.test/settings/morning-brief",
    resultMarkdown,
  };
}

const unsubscribeUrl = "https://api.okou.test/api/email/unsubscribe?token=test";

describe("Morning Brief result email renderer boundary", () => {
  it("renders an exact 32 KiB multibyte and adversarial body without truncation", () => {
    const resultMarkdown = exactBoundaryMarkdown();
    expect(Buffer.byteLength(resultMarkdown, "utf8")).toBe(
      MORNING_BRIEF_RESULT_EMAIL_BODY_MAX_BYTES,
    );

    const rendered = renderMorningBriefResultEmail(
      renderProps(resultMarkdown),
      unsubscribeUrl,
    );

    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).not.toContain("<img src=x");
    expect(rendered.html).not.toContain('href="javascript:');
    expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered.html).toContain(
      'href="https://example.test/source?a=1&amp;b=2"',
    );
    expect(rendered.text).toContain("<script>alert(1)</script>");
    expect(rendered.text).toContain("https://example.test/source?a=1&b=2");
    expect(rendered.text).toContain("café 漢字 & bold");
    expect(rendered.html).toContain("END-OF-ACCEPTED-BODY</p>");
    expect(rendered.text).toContain("END-OF-ACCEPTED-BODY");
  });

  it("rejects the first byte above the 32 KiB UTF-8 boundary", () => {
    const resultMarkdown = `${exactBoundaryMarkdown()}x`;
    expect(Buffer.byteLength(resultMarkdown, "utf8")).toBe(
      MORNING_BRIEF_RESULT_EMAIL_BODY_MAX_BYTES + 1,
    );

    expect(() => {
      return renderMorningBriefResultEmail(
        renderProps(resultMarkdown),
        unsubscribeUrl,
      );
    }).toThrow(
      new MorningBriefResultEmailRenderError(
        `Morning Brief result body is ${MORNING_BRIEF_RESULT_EMAIL_BODY_MAX_BYTES + 1} bytes, above the ${MORNING_BRIEF_RESULT_EMAIL_BODY_MAX_BYTES} byte template bound`,
      ),
    );
  });
});
