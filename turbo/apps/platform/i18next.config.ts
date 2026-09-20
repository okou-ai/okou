import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: [
    "en-US",
    "pt-BR",
    "ja-JP",
    "ko-KR",
    "id-ID",
    "de-DE",
    "es-ES",
    "it-IT",
    "fr-FR",
    "hi-IN",
  ],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    ignore: [
      "src/**/__tests__/**",
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
      "src/mocks/**",
      "src/test/**",
    ],
    output: "src/i18n/locales/{{language}}/{{namespace}}.json",
    defaultNS: "common",
    functions: ["i18n.t"],
    preservePatterns: [
      "activity.network.details.*",
      "artifacts.templates.workflowCatalog.*",
      "artifacts.templates.workflowCategories.*",
      // Shared bot views choose the provider at runtime.
      "connectors.providerSettings.feishu.*",
      "connectors.providerSettings.lark.*",
      "connectors.providerConnect.feishu.*",
      "connectors.providerConnect.lark.*",
      "onboarding.categories.*",
      "onboarding.make.options.*",
      // Source-first onboarding indexes these by industry, source family, or
      // connector slug at runtime.
      "onboarding.sourcesFirst.industries.*",
      "onboarding.sourcesFirst.startingPrompt.*",
      "onboarding.templates.*.*",
      "onboarding.workflows.*",
      // Paid tool rows select copy by the shared tool catalog at runtime.
      "settings.paidTools.tools.*",
    ],
    primaryLanguage: "en-US",
    useTranslationNames: ["useTranslation"],
  },
});
