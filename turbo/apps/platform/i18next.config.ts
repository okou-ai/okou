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
    "zh-Hans",
    "zh-Hant",
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
      // VNC settings select one allow-listed connection failure at runtime.
      "vnc.connectionStatus.reasons.*",
      "activity.network.details.*",
      "artifacts.templates.workflowCatalog.*",
      "artifacts.templates.workflowCategories.*",
      // Document purposes are selected from the shared catalog at runtime.
      "documentTemplates.categories.*",
      // Shared bot views choose the provider at runtime.
      "connectors.providerSettings.feishu.*",
      "connectors.providerSettings.lark.*",
      "connectors.providerConnect.feishu.*",
      "connectors.providerConnect.lark.*",
      // Source-first onboarding indexes these by industry, source family, or
      // connector slug at runtime.
      "onboarding.sourcesFirst.capabilities.items.*",
      "onboarding.sourcesFirst.industries.*",
      "onboarding.sourcesFirst.startingPrompt.*",
      "onboarding.sourcesFirst.outcomes.*",
      "onboarding.sourcesFirst.outputFormats.*",
      // Paid tool rows select copy by the shared tool catalog at runtime.
      "settings.paidTools.tools.*",
      // Halloween content is loaded as an on-demand feature namespace, and
      // question copy is selected by the IDs supplied by the API.
      "halloween:*",
    ],
    primaryLanguage: "en-US",
    useTranslationNames: ["useTranslation"],
  },
});
