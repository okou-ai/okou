import { describe, expect, it } from "vitest";
import {
  renderAgentMorningBriefEmail,
  renderAgentNotificationEmail,
} from "../agent-notification-email-renderer";

describe("pure agent notification email rendering", () => {
  it.each([renderAgentNotificationEmail, renderAgentMorningBriefEmail])(
    "preserves non-default and nested list numbering in either notification purpose",
    (render) => {
      const email = render(
        {
          subject: "Next steps",
          text: "## Continue\n3. Third step\n4. Fourth step\n\n## Zero-based\n0. Zero step\n1. First step\n\n## Nested\n1. Outer step\n\n   5. Nested step\n   6. Next nested step",
          runUrl: "https://app.okou.ai/activities/run-1",
          manageUrl: "https://app.okou.ai/agents?settings=preference",
        },
        "https://app.okou.ai/unsubscribe",
      );
      expect(email.html).toContain('<ol start="3"');
      expect(email.html).toContain('<ol start="0"');
      expect(email.html).toContain('<ol start="5"');
      expect(email.html).not.toContain("<pre");
      expect(email.text).toContain("3. Third step");
      expect(email.text).toContain("0. Zero step");
      expect(email.text).toContain("5. Nested step");
    },
  );

  it("validates entity-decoded links and keeps raw HTML, images and task markers inert", () => {
    const email = renderAgentNotificationEmail(
      {
        subject: "Safe content",
        text: [
          "[safe](https&#58;//example.com/?a=1&amp;b=2) [mail](mailto:hello@example.com)",
          "[script](javascript&#58;alert(1)) [data](data:text/html,test) [relative](/private) [http](http://example.com)",
          "[control](java&#x09;script:alert(1)) [hostless](https:example.com) [mail-host](mailto://example.com)",
          "![**<img src=x onerror=alert(1)>** &amp; visible](https://example.com/pixel.png)",
          '<script>alert(1)</script>\n<a href="https://raw.example.com">raw</a>',
          "- [x] Completed\n- [ ] Pending",
          "https://bare.example.com",
        ].join("\n\n"),
        runUrl: "https://app.okou.ai/activities/run-1",
      },
      "https://app.okou.ai/unsubscribe",
    );
    expect(email.html).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(email.html).toContain('href="mailto:hello@example.com"');
    expect(email.text).toContain("script data relative http");
    expect(email.text).toContain("control hostless mail-host");
    expect(email.html).not.toMatch(
      /href="(?:javascript:|data:|http:|\/private|mailto:\/\/)/u,
    );
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("<input");
    expect(email.html).not.toContain("pixel.png");
    expect(email.html).not.toContain('href="https://raw.example.com"');
    expect(email.html).not.toContain('href="https://bare.example.com"');
    expect(email.text).toContain("<img src=x onerror=alert(1)> & visible");
    expect(email.text).toContain("[x] Completed");
    expect(email.text).toContain("[ ] Pending");
  });

  it("keeps styled tables, code, emphasis and quotes in the email Markdown subset", () => {
    const email = renderAgentNotificationEmail(
      {
        subject: "Project update",
        text: [
          "## Status\n**Ready** and *reviewed*, ~~blocked~~.",
          "| Task | State |\n| --- | --- |\n| Launch | Ready |",
          "> Share with the team.",
          "Use `<tag>&value`.",
          "```mermaid\ngraph TD; A-->B\n```",
        ].join("\n\n"),
        runUrl: "https://app.okou.ai/activities/run-1",
      },
      "https://app.okou.ai/unsubscribe",
    );
    expect(email.html).toContain('<table role="presentation" width="100%"');
    expect(email.html).toContain('<thead style="background-color:#faf5f3">');
    expect(email.html).toContain(
      '<strong style="font-weight:700">Ready</strong>',
    );
    expect(email.html).toContain('<em style="font-style:italic">reviewed</em>');
    expect(email.html).toContain(
      '<s style="text-decoration:line-through">blocked</s>',
    );
    expect(email.html).toContain("<blockquote style=");
    expect(email.html).toContain("&lt;tag&gt;&amp;value");
    expect(email.html).toContain("graph TD; A--&gt;B");
    expect(email.text).toContain("Launch");
    expect(email.text).toContain("Share with the team.");
  });

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
