import assert from "node:assert/strict";
import test from "node:test";

import { checkSource, formatFailure } from "./check-clerk-customize.mjs";

const componentAppearancePath = "src/views/auth-v1/component-appearance.ts";

function violationReasons(
  sourceText,
  relativePath = "src/views/auth-v1/example.tsx",
) {
  return checkSource(relativePath, sourceText).map(({ reason }) => {
    return reason;
  });
}

await test("accepts public Clerk appearance slots and their own states", () => {
  const reasons = violationReasons(`
    // E2E may observe .cl-*; production customization never targets it.
    export const appearance = {
      theme: "simple",
      elements: {
        rootBox: "mx-auto flex w-full",
        cardBox: cn(cardClassName, "w-full shadow-none"),
        otpCodeFieldInput:
          "border-[0.7px] data-[focus-within=true]:border-primary aria-invalid:border-destructive",
      },
    };
  `);

  assert.deepEqual(reasons, []);
});

await test("rejects the legacy Clerk DOM adapter patterns", () => {
  const reasons = violationReasons(`
    const clerkCss = \`
      .cl-card,
      [class*="cl-card"],
      [data-localization-key="formButtonPrimary"],
      button[type="submit"],
      .field:has(input) {
        border: 1px solid red !important;
      }
    \`;
    export function Layout() {
      return <style>{clerkCss}</style>;
    }
  `);

  assert.deepEqual(
    new Set(reasons),
    new Set([
      "depends on a Clerk-owned class",
      "matches Clerk DOM through a class attribute selector",
      "depends on Clerk's internal localization attribute",
      "targets a Clerk control by its rendered element structure",
      "depends on Clerk's internal DOM structure through :has()",
      "uses !important",
      "injects a raw <style> element",
    ]),
  );
});

await test("rejects stylesheets and inline styling", () => {
  const reasons = violationReasons(`
    import "./clerk.css";
    export function Layout() {
      return <div style={{ color: "red" }} dangerouslySetInnerHTML={{ __html: "" }} />;
    }
  `);

  assert.deepEqual(
    new Set(reasons),
    new Set([
      "imports a route-owned stylesheet",
      "adds inline styles to the Clerk V1 implementation",
      "can inject raw styles or Clerk DOM markup",
    ]),
  );
});

await test("keeps element customization out of provider scope and CSS-in-JS", () => {
  assert.deepEqual(
    new Set(
      violationReasons(
        `
          export const appearance = {
            elements: {
              formFieldInput: { borderColor: "red" },
            },
          };
        `,
        "src/views/auth-v1/provider-appearance.ts",
      ),
    ),
    new Set([
      "adds element overrides at provider scope instead of the V1 auth component scope",
      "uses a CSS-in-JS object instead of Tailwind classes on a public Clerk element slot",
    ]),
  );
});

await test("failure output directs contributors to the Clerk guide", () => {
  const output = formatFailure([
    {
      column: 5,
      line: 10,
      reason: "uses !important",
      relativePath: componentAppearancePath,
    },
  ]);

  assert.match(output, /Read docs\/clerk-customize\.md/u);
  assert.match(output, /component-appearance\.ts:10:5 uses !important/u);
});
