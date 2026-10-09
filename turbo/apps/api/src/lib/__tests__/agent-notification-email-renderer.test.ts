import { describe, expect, it } from "vitest";
import { renderAgentNotificationEmail } from "../agent-notification-email-renderer";

describe("pure agent notification email rendering", () => {
  it("renders Markdown, preserves safe links, strips tracking images and unsafe anchors, and includes provenance and opt-out", () => {
    const email = renderAgentNotificationEmail(
      {
        subject: "Update <today>",
        text: "## Today\n**Useful** [link](https://example.com) ![tracker](https://example.com/pixel.png) [unsafe](javascript:alert(1))\n<script>alert(1)</script>",
        runUrl: "https://app.okou.ai/activities/run-1",
      },
      "https://app.okou.ai/unsubscribe?token=test",
    );
    expect(email.html).toContain("Update &lt;today&gt;");
    expect(email.html).toContain('href="https://example.com"');
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain('href="javascript:');
    expect(email.html).not.toContain("pixel.png");
    expect(email.html).toContain('href="https://app.okou.ai/activities/run-1"');
    expect(email.html).toContain(
      'href="https://app.okou.ai/unsubscribe?token=test"',
    );
    expect(email.text).toContain("Useful");
    expect(email.text).toContain("Unsubscribe");
  });

  it("bounds HTML expansion for a body containing many Markdown list items", () => {
    const text = "- x\n".repeat(1900);
    const email = renderAgentNotificationEmail(
      {
        subject: "Update",
        text,
        runUrl: "https://app.okou.ai/activities/run-1",
      },
      "https://app.okou.ai/unsubscribe",
    );
    expect(Buffer.byteLength(email.html, "utf8")).toBeLessThanOrEqual(
      96 * 1024,
    );
    expect(email.html).toContain("<pre");
    expect(email.text).toContain("Open in");
  });
});
