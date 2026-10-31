import { enum as zEnum, type infer as zInfer } from "zod";

export const SUPPORTED_USER_LOCALES = [
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
  // Chinese is split by script rather than by region: Simplified and
  // Traditional are not interchangeable for a reader, and a zh-TW browser must
  // not resolve to the Simplified bundle.
  "zh-Hans",
  "zh-Hant",
] as const;
export const userLocaleSchema = zEnum(SUPPORTED_USER_LOCALES);
export type UserLocale = zInfer<typeof userLocaleSchema>;
export const DEFAULT_USER_LOCALE = "en-US" satisfies UserLocale;
