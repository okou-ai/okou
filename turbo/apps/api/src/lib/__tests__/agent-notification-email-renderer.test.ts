import { describe, expect, it } from "vitest";
import {
  renderAgentMorningBriefEmail,
  renderAgentNotificationEmail,
} from "../agent-notification-email-renderer";

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

  it("uses the original Morning Brief rendering, artwork, management and unsubscribe controls", () => {
    const props = {
      subject: "Morning Brief",
      text: "## Today\n**Useful** [link](https://example.com) ![tracker](https://example.com/pixel.png) [unsafe](javascript:alert(1))",
      runUrl: "https://app.okou.ai/activities/run-1",
      manageUrl:
        "https://app.okou.ai/agents?settings=preference&focus=morning-brief",
    };
    const unsubscribeUrl = "https://app.okou.ai/email/unsubscribe?token=test";
    const email = renderAgentMorningBriefEmail(props, unsubscribeUrl);
    expect(email.html).toContain('src="https://a.okou.io/vfv041yxil.png"');
    expect(email.text).toContain("Manage");
    expect(email.text).toContain(props.manageUrl);
    expect(email.text).toContain("Unsubscribe");
    expect(email.text).toContain("Sent by an Okou automation");
    expect(email.html).not.toContain("pixel.png");
    expect(email.html).not.toContain('href="javascript:');

    const ordinary = renderAgentNotificationEmail(props, unsubscribeUrl);
    expect(ordinary.html).toContain("<h1");
    expect(ordinary.text).toContain("Sent by your Okou agent");
    expect(ordinary.text).not.toContain("Manage");
    expect(ordinary.html).not.toContain("vfv041yxil.png");
  });

  it.each([renderAgentNotificationEmail, renderAgentMorningBriefEmail])(
    "bounds HTML expansion for either notification purpose",
    (render) => {
      const text = "- x\n".repeat(1900);
      const email = render(
        {
          subject: "Update",
          text,
          runUrl: "https://app.okou.ai/activities/run-1",
          manageUrl:
            "https://app.okou.ai/agents?settings=preference&focus=morning-brief",
        },
        "https://app.okou.ai/unsubscribe",
      );
      expect(Buffer.byteLength(email.html, "utf8")).toBeLessThanOrEqual(
        96 * 1024,
      );
      expect(email.html).toContain("<pre");
      expect(email.text).toContain("Open in");
    },
  );
});
