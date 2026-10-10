import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const desktopUpgradeRequiredSchema = apiErrorSchema.extend({
  minimumSupportedVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
});

/**
 * Every desktop update line the `:product` routes accept.
 *
 * `ai-okou-desktop` is the only line the API serves. The retired `okou` line
 * stays in the union for installed Electron clients so its routes keep
 * returning 404 rather than a path-param validation error. Its compatibility
 * retirement is tracked separately in #37888.
 */
export const DESKTOP_UPDATE_LINE_LEGACY_OKOU = "okou";
export const DESKTOP_UPDATE_LINE_OKOU = "ai-okou-desktop";
const DESKTOP_UPDATE_LINES = [
  DESKTOP_UPDATE_LINE_LEGACY_OKOU,
  DESKTOP_UPDATE_LINE_OKOU,
] as const;

const desktopUpdateChannelSchema = z.enum(["stable"]);
const desktopUpdatePlatformSchema = z.enum(["darwin"]);
const desktopUpdateArchitectureSchema = z.enum(["arm64"]);
const desktopUpdateLineSchema = z.enum(DESKTOP_UPDATE_LINES);

export type DesktopUpdateChannel = z.infer<typeof desktopUpdateChannelSchema>;
export type DesktopUpdatePlatform = z.infer<typeof desktopUpdatePlatformSchema>;
export type DesktopUpdateArchitecture = z.infer<
  typeof desktopUpdateArchitectureSchema
>;
export type DesktopUpdateLine = z.infer<typeof desktopUpdateLineSchema>;

const squirrelMacReleaseSchema = z.object({
  version: z.string(),
  updateTo: z.object({
    name: z.string(),
    version: z.string(),
    pub_date: z.string(),
    url: z.string().url(),
    notes: z.string(),
  }),
});

const squirrelMacReleasesSchema = z.object({
  currentRelease: z.string(),
  releases: z.array(squirrelMacReleaseSchema),
});

export type SquirrelMacReleases = z.infer<typeof squirrelMacReleasesSchema>;

/**
 * Native appcast and release/download routes read the same upstream release-asset
 * manifest, so they share the same `503`: the manifest host was
 * unreachable, the API retried within its bound, and no manifest recent enough
 * to serve was cached. It is deliberately distinct from `404` ("this feed
 * resolves to no release") and from `500` ("the manifest is missing or
 * invalid"), which stay loud because they need a human. The frozen Squirrel
 * migration feed is independent of this mutable manifest.
 */
export const desktopUpdatesContract = c.router({
  compatibility: {
    method: "GET",
    path: "/api/desktop/compatibility",
    responses: {
      200: z.object({
        minimumSupportedVersion: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/u)
          .nullable(),
      }),
    },
    summary:
      "Read the globally enforced Desktop version floor without signing in",
  },
  productAppcast: {
    method: "GET",
    path: "/api/desktop/updates/:product/:channel/:platform/:arch/appcast.xml",
    pathParams: z.object({
      product: desktopUpdateLineSchema,
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/rss+xml",
        body: z.string(),
      }),
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get the native desktop Sparkle update feed",
  },
  releasePage: {
    method: "GET",
    path: "/api/desktop/updates/:channel/:platform/:arch/release",
    pathParams: z.object({
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      302: c.noBody(),
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Redirect to the current desktop release page",
  },
  dmgDownload: {
    method: "GET",
    path: "/api/desktop/updates/:channel/:platform/:arch/dmg",
    pathParams: z.object({
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      302: c.noBody(),
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Redirect to the current desktop DMG download",
  },
  productReleasePage: {
    method: "GET",
    path: "/api/desktop/updates/:product/:channel/:platform/:arch/release",
    pathParams: z.object({
      product: desktopUpdateLineSchema,
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      302: c.noBody(),
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Redirect to an identity-specific desktop release page",
  },
  productDmgDownload: {
    method: "GET",
    path: "/api/desktop/updates/:product/:channel/:platform/:arch/dmg",
    pathParams: z.object({
      product: desktopUpdateLineSchema,
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      302: c.noBody(),
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Redirect to an identity-specific desktop DMG download",
  },
  productFeed: {
    method: "GET",
    path: "/api/desktop/updates/:product/:channel/:platform/:arch/RELEASES.json",
    pathParams: z.object({
      product: desktopUpdateLineSchema,
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      200: squirrelMacReleasesSchema,
      400: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get the fixed Electron-to-Native desktop migration feed",
  },
});
