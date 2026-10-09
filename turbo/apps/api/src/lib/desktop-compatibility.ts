import { z } from "zod";

import compatibilityConfig from "./desktop-compatibility.json";
import { desktopVersionIsSupported } from "./desktop-version";

const desktopCompatibilityConfigSchema = z.object({
  minimumSupportedVersion: z
    .string()
    .refine((value) => {
      return desktopVersionIsSupported(value, "0.51.0");
    }, "The Desktop floor must be a stable version at least 0.51.0")
    .nullable(),
});

desktopCompatibilityConfigSchema.parse(compatibilityConfig);

// Global source-controlled policy; changes require a PR and an API release.
// Keep null until the replacement is published and serving/rollback APIs support
// admission and draining. #38098 owns activation; #37997 owns token retirement.
export function desktopMinimumSupportedVersion(): string | null {
  return desktopCompatibilityConfigSchema.parse(compatibilityConfig)
    .minimumSupportedVersion;
}

export function desktopUpgradeRequired(minimumSupportedVersion: string) {
  return {
    status: 426 as const,
    body: {
      error: {
        code: "DESKTOP_UPDATE_REQUIRED" as const,
        message: `Update Okou to ${minimumSupportedVersion} or later to continue Computer Use.`,
      },
      minimumSupportedVersion,
    },
  };
}
