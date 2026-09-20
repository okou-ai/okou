import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import css from "@eslint/css";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import { tailwind4 } from "tailwind-csstree";
import tseslint from "typescript-eslint";

const allowlist = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "style-allowlist.json"), "utf8"),
);

// The classes an allowlisted third-party DOM dependency puts on an element. The
// policy owns which file may carry each one and how often; this only keeps the
// unknown-class rule from flagging a name that is authorized somewhere.
const allowlistedClasses = allowlist.classDependencies.map((entry) => {
  return entry.token;
});

function exactRegex(value) {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

// The stroke weights live in `@theme`, so a component asks for a border and the
// system decides how thick it is. These catch the two ways a component can open
// a second registry for that decision: an arbitrary-length border utility, and a
// width written into a `style` prop. A bare `border-2` is deliberately still
// allowed — it is geometry that is not a boundary (a dashed drop target, a
// spinner's ring, a switch track's inset), which is a different decision rather
// than a competing value for this one. Selection is not on that list: see
// "Stroke weight" in docs/styles.md.
const ARBITRARY_BORDER_WIDTH_CLASS =
  "border(-[xytblrse])?-\\[[0-9.]+(px|rem|em)\\]";
const strokeWidthRestrictions = [
  {
    selector: `Literal[value=/${ARBITRARY_BORDER_WIDTH_CLASS}/]`,
    message:
      "Do not hand-write a border width. Use `border` for the shared hairline, or `border-(length:--border-width-emphasis)` for a line that is itself the signal. See docs/styles.md.",
  },
  {
    selector: `TemplateElement[value.raw=/${ARBITRARY_BORDER_WIDTH_CLASS}/]`,
    message:
      "Do not hand-write a border width. Use `border` for the shared hairline, or `border-(length:--border-width-emphasis)` for a line that is itself the signal. See docs/styles.md.",
  },
  {
    selector:
      "Property[key.name=/^border(Block|Inline|Top|Right|Bottom|Left)?(Start|End)?Width$/]",
    message:
      "A border width in a `style` prop is a second registry for a decision the stroke tokens own. Move it to a Tailwind utility. See docs/styles.md.",
  },
  {
    selector:
      "Property[key.name='border'] Literal[value=/^[0-9.]+(px|rem|em)/]",
    message:
      "A literal border width in a `style` prop is a second registry for a decision the stroke tokens own. Read a registered token instead, e.g. `var(--border-width-emphasis) solid …`. See docs/styles.md.",
  },
  {
    selector:
      "Property[key.name='border'] TemplateElement[value.raw=/^[0-9.]+(px|rem|em)/]",
    message:
      "A literal border width in a `style` prop is a second registry for a decision the stroke tokens own. Read a registered token instead, e.g. `var(--border-width-emphasis) solid …`. See docs/styles.md.",
  },
];

const productionSourceFiles = [
  "apps/platform/src/**/*.{ts,tsx}",
  "packages/ui/src/**/*.{ts,tsx}",
];
const testAndFixtureFiles = [
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "**/mocks/**",
  "**/test-fixtures/**",
  "**/*.test.{ts,tsx}",
  "**/*.spec.{ts,tsx}",
  "apps/platform/src/test/**",
  "packages/ui/src/test/**",
];

export default [
  {
    files: ["apps/platform/src/**/*.css", "packages/ui/src/**/*.css"],
    ignores: [
      "apps/platform/src/views/css/vendor/uiw-react-markdown-preview-5.2.0.css",
    ],
    language: "css/css",
    languageOptions: {
      customSyntax: tailwind4,
    },
    plugins: { css },
    rules: {
      "css/no-empty-blocks": "error",
    },
  },
  {
    files: productionSourceFiles,
    ignores: testAndFixtureFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: {
      "better-tailwindcss": betterTailwindcss,
    },
    settings: {
      "better-tailwindcss": {
        cwd: resolve(import.meta.dirname, "apps/platform"),
        detectComponentClasses: false,
        entryPoint: resolve(
          import.meta.dirname,
          "apps/platform/src/views/css/index.css",
        ),
        tsconfig: resolve(import.meta.dirname, "apps/platform/tsconfig.json"),
      },
    },
    rules: {
      "better-tailwindcss/no-unknown-classes": [
        "error",
        {
          attributes: ["class", "className", "contentClassName"],
          ignore: allowlistedClasses.map(exactRegex),
        },
      ],
      "no-restricted-syntax": ["error", ...strokeWidthRestrictions],
    },
  },
  {
    // Each file is exempt for its own reason, recorded at its own call site:
    //
    // - `chat-card.tsx` pins a whole pixel because a fractional border visibly
    //   repaints when the card's content resolves, so the edge flickers as an
    //   image or an iframe lands inside it. `docs/styles.md` records this.
    // - `mermaid-diagram.tsx` pins one only to preserve the width the rule it
    //   replaced drew. That is a weaker argument than the flicker one and is
    //   worth re-examining on its own merits; it is carried unchanged here
    //   rather than settled by a guard that was not written for it.
    //
    // Neither is a competing opinion about how thick a border is.
    files: [
      "apps/platform/src/views/components/mermaid-diagram.tsx",
      "apps/platform/src/views/okou-page/components/chat-card.tsx",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
