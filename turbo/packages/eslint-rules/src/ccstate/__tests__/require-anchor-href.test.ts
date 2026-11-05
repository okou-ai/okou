import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/require-anchor-href.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("require-anchor-href", rule, {
  valid: [
    { code: `<a href="https://example.com">Docs</a>` },
    { code: `<a href={url}>Docs</a>` },
    { code: `<a href={\`/chats/\${threadId}\`}>Thread</a>` },
    // A fragment link navigates within the page.
    { code: `<a href="#pricing">Pricing</a>` },
    // Client-side routing keeps the real destination for modified clicks.
    { code: `<a href={href} onClick={handleLinkClick}>Open</a>` },
    // A conditional with two real destinations.
    { code: `<a href={external ? url : "/settings"}>Open</a>` },
    // Components are out of scope; Router Link types its own pathname.
    { code: `<Link pathname="/agents">Agents</Link>` },
    { code: `<Button onClick={copy}>Copy</Button>` },
  ],
  invalid: [
    {
      code: `<a onClick={copy}>Copy</a>`,
      errors: [{ messageId: "missingHref" }],
    },
    // The destination must be visible where the anchor is written.
    {
      code: `<a {...props}>Copy</a>`,
      errors: [{ messageId: "missingHref" }],
    },
    {
      code: `<TooltipTrigger render={<a onClick={copy} />} />`,
      errors: [{ messageId: "missingHref" }],
    },
    {
      code: `<a href="#" onClick={copy}>Copy</a>`,
      errors: [{ messageId: "placeholderHref" }],
    },
    {
      code: `<a href="" onClick={copy}>Copy</a>`,
      errors: [{ messageId: "placeholderHref" }],
    },
    {
      code: `<a href="javascript:void(0)">Copy</a>`,
      errors: [{ messageId: "placeholderHref" }],
    },
    {
      code: `<a href="  JavaScript:alert(1)">Copy</a>`,
      errors: [{ messageId: "placeholderHref" }],
    },
    {
      code: `<a href="vbscript:msgbox(1)">Copy</a>`,
      errors: [{ messageId: "placeholderHref" }],
    },
    {
      code: `<a href="data:text/html,<p>hi</p>">Open</a>`,
      errors: [{ messageId: "placeholderHref" }],
    },
    {
      code: `<a href={"#"}>Copy</a>`,
      errors: [{ messageId: "placeholderHref" }],
    },
    {
      code: `<a href={undefined}>Copy</a>`,
      errors: [{ messageId: "placeholderHref" }],
    },
    {
      code: `<a href={ready ? url : "#"}>Download</a>`,
      errors: [{ messageId: "placeholderHref" }],
    },
    {
      code: `<a href>Copy</a>`,
      errors: [{ messageId: "placeholderHref" }],
    },
    {
      code: `<a href={url} role="button" onClick={copy}>Copy</a>`,
      errors: [{ messageId: "roleButton" }],
    },
  ],
});
