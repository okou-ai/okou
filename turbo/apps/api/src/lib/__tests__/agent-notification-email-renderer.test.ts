import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { expect, test } from "vitest";

import { testContext } from "../../__tests__/test-context";
import {
  renderAgentMorningBriefEmail,
  renderAgentNotificationEmail,
} from "../agent-notification-email-renderer";

testContext();

const RUN_URL = "https://app.okou.ai/threads/thread-1/runs/run-1";
const UNSUBSCRIBE_URL = "https://app.okou.ai/notifications/unsubscribe/token-1";
const MANAGE_URL = "https://app.okou.ai/automations/morning-brief";

function renderRegular(text: string, subject = "Agent update") {
  return renderAgentNotificationEmail(
    { subject, text, runUrl: RUN_URL },
    UNSUBSCRIBE_URL,
  );
}

test("agent-notification-email-renderer-001 keeps non-default and nested ordered list numbers", () => {
  const email = renderRegular(
    [
      "3. Third step",
      "4. Fourth step",
      "",
      "Next section",
      "",
      "0. Zeroth step",
      "   5. Nested fifth",
      "   6. Nested sixth",
    ].join("\n"),
  );

  expect(email.html).toContain('<ol start="3"');
  expect(email.html).toContain('<ol start="0"');
  expect(email.html).toContain('<ol start="5"');
  expect(email.html).not.toContain("<pre");
  expect(email.text).toContain("3. Third step");
  expect(email.text).toContain("0. Zeroth step");
  expect(email.text).toContain("5. Nested fifth");
});

test("agent-notification-email-renderer-003 links only decoded HTTPS and mail targets and keeps raw HTML, images and tasks inert", () => {
  const email = renderRegular(
    [
      "[Guide](https&#x3A;//docs.example.com/guide?x=1&amp;y=2)",
      "",
      "[Mail us](mailto:team@example.com)",
      "",
      "[Script link](javascript&#58;alert(1)) [Plain HTTP](http://insecure.example/page) [Broken](https://)",
      "",
      "![Tracking pixel](https://tracker.example/pixel.gif)",
      "",
      '<a href="https://raw.example/anchor">raw anchor</a>',
      "",
      "Visit https://bare.example/path today",
      "",
      "- [x] Shipped task",
      "- [ ] Open task",
    ].join("\n"),
  );

  expect(email.html).toContain(
    'href="https://docs.example.com/guide?x=1&amp;y=2"',
  );
  expect(email.html).toContain('href="mailto:team@example.com"');
  for (const label of ["Script link", "Plain HTTP", "Broken"]) {
    expect(email.html).toContain(label);
  }
  expect(email.html).not.toContain("javascript");
  expect(email.html).not.toContain('href="http://insecure.example');
  expect(email.html).not.toContain('href="https://"');
  expect(email.html).not.toContain("tracker.example");
  expect(email.html).not.toContain("<img");
  expect(email.html).not.toContain("<input");
  expect(email.html).toContain("&lt;a href=");
  expect(email.html).not.toContain('href="https://raw.example/anchor"');
  expect(email.html).toContain("https://bare.example/path");
  expect(email.html).not.toContain('href="https://bare.example/path"');
  expect(email.text).toContain("Tracking pixel");
  expect(email.text).toContain("[x] Shipped task");
  expect(email.text).toContain("[ ] Open task");
});

test("agent-notification-email-renderer-004 keeps styled tables, emphasis, quotes and escaped code", () => {
  const email = renderRegular(
    [
      "| Metric | Value |",
      "| --- | --- |",
      "| Revenue | 42 |",
      "",
      "**Bold claim** and *gentle note* and ~~old plan~~",
      "",
      "> Quoted insight",
      "",
      "Use `a <b> & c` carefully",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
    ].join("\n"),
  );

  expect(email.html).toContain(
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:100%;table-layout:fixed',
  );
  expect(email.html).toMatch(
    /<thead style="[^"]+"><tr>\s*<th style="[^"]+">Metric<\/th>/,
  );
  expect(email.html).toContain(
    '<strong style="font-weight:700">Bold claim</strong>',
  );
  expect(email.html).toContain(
    '<em style="font-style:italic">gentle note</em>',
  );
  expect(email.html).toContain(
    '<s style="text-decoration:line-through">old plan</s>',
  );
  expect(email.html).toMatch(
    /<blockquote style="[^"]+">\s*<p[^>]*>Quoted insight<\/p>/,
  );
  expect(email.html).toContain("a &lt;b&gt; &amp; c");
  expect(email.html).toContain("A--&gt;B");
  expect(email.text).toContain("Revenue");
  expect(email.text).toContain("42");
  expect(email.text).toContain("Quoted insight");
});

test("agent-notification-email-renderer-005 escapes the subject, keeps safe links and strips pixels, unsafe anchors and scripts", () => {
  const email = renderRegular(
    [
      "**Important** update for you",
      "",
      "[Read the report](https://safe.example/report)",
      "",
      "![pixel](https://tracker.example/open.gif)",
      "",
      "[Click me](javascript:alert(1)) [Data](data:text/html,hi)",
      "",
      "<script>alert(1)</script>",
    ].join("\n"),
    "Weekly <report> & notes",
  );

  expect(email.html).toContain("Weekly &lt;report&gt; &amp; notes");
  expect(email.html).not.toContain("Weekly <report>");
  expect(email.html).toContain('href="https://safe.example/report"');
  expect(email.html).toContain(`href="${RUN_URL}"`);
  expect(email.html).toContain(`href="${UNSUBSCRIBE_URL}"`);
  expect(email.html).not.toContain("<script");
  expect(email.html).not.toContain("javascript:");
  expect(email.html).not.toContain('href="data:');
  expect(email.html).not.toContain("tracker.example");
  expect(email.text).toContain("Important");
  expect(email.text).toContain("Unsubscribe");
});

test("agent-notification-email-renderer-006 renders the Morning Brief artwork and controls only for the Brief", () => {
  const subject = "Your morning brief";
  const text = [
    "## Today",
    "",
    "[Calendar](https://calendar.example/today)",
    "",
    "![pixel](https://tracker.example/brief.gif)",
    "",
    "[Unsafe](javascript:alert(1))",
  ].join("\n");

  const brief = renderAgentMorningBriefEmail(
    { subject, text, runUrl: RUN_URL, manageUrl: MANAGE_URL },
    UNSUBSCRIBE_URL,
  );
  const regular = renderRegular(text, subject);

  const assistant = BRAND_PRESENTATION.assistantName;
  expect(brief.html).toContain('<img src="https://a.okou.io/vfv041yxil.png"');
  expect(brief.html).toContain(`href="${MANAGE_URL}"`);
  expect(brief.html).toContain(">Unsubscribe</a>");
  expect(brief.html).toContain(`Sent by an ${assistant} automation`);
  expect(brief.html).not.toContain("tracker.example");
  expect(brief.html).not.toContain("javascript:");
  expect(regular.html).toContain(`>${subject}</h1>`);
  expect(regular.html).toContain(`Sent by your ${assistant} agent`);
  expect(regular.html).not.toContain("https://a.okou.io/vfv041yxil.png");
  expect(regular.html).not.toContain(">Manage</a>");
});
