import assert from "node:assert/strict";
import test from "node:test";

import {
  checkTranslationResources,
  findTranslationWhitespaceIssues,
} from "./check-i18n-whitespace.node.mjs";

await test("all shipped locales and namespaces have no accidental whitespace artifacts", () => {
  assert.deepEqual(checkTranslationResources(), []);
});

await test("rejects trailing line breaks and literal newline artifacts", () => {
  assert.deepEqual(
    findTranslationWhitespaceIssues({
      onboarding: {
        actual: "A sentence\n",
        literal: "A sentence\\n",
      },
    }),
    [
      String.raw`onboarding.actual: trailing newline or literal \n`,
      String.raw`onboarding.literal: trailing newline or literal \n`,
    ],
  );
});

await test("rejects repeated spaces but preserves intentional rich-text boundaries", () => {
  assert.deepEqual(
    findTranslationWhitespaceIssues({
      suffix: " link after",
      prefix: "Before link ",
      sentence: "Wrong  spacing",
      localUnits: "已工作 {{duration}}",
      japanese: "{{hours}}時間{{minutes}}分",
    }),
    ["sentence: repeated ASCII spaces"],
  );
});
