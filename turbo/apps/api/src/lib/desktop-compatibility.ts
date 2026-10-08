import { env } from "./env";

// Global deployment switch, deliberately independent of per-user Lab overrides.
// Leave unset until the replacement is published and every serving/rollback API
// supports this admission contract. #38098 owns activation; #37997 owns retirement.
export function desktopMinimumSupportedVersion(): string | null {
  return env("OKOU_DESKTOP_MINIMUM_SUPPORTED_VERSION") ?? null;
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
