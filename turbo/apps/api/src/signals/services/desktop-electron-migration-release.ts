import type { DesktopUpdateRelease } from "./desktop-updates.service";

/**
 * Immutable migration hop for installed ai-okou-desktop Squirrel clients.
 * This signed/notarized Native ZIP contains the ShipIt relaunch bridge and
 * then updates through Sparkle. Never follow the mutable Native manifest here:
 * dormant Electron installations can skip every intermediate release.
 * Retain the original release asset; retirement and rollback gates: #37888.
 */
export const desktopElectronMigrationRelease = {
  version: "0.52.2",
  name: "Okou 0.52.2",
  notes: "",
  pubDate: "2026-10-10T06:04:27.216Z",
  url: "https://github.com/okou-ai/okou/releases/download/okou-desktop-v0.52.2/Okou-darwin-arm64-0.52.2.zip",
} as const satisfies DesktopUpdateRelease;
