import { desktopVersionIsSupported } from "../../lib/desktop-version";
import {
  DESKTOP_UPDATE_LINE_LEGACY_OKOU,
  DESKTOP_UPDATE_LINE_OKOU,
  desktopUpdatesContract,
  type DesktopUpdateLine,
  type SquirrelMacReleases,
} from "@okouai/api-contracts/contracts/desktop-updates";
import { command } from "ccstate";

import { desktopMinimumSupportedVersion } from "../../lib/desktop-compatibility";
import { desktopUpdateUnavailable, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { desktopElectronMigrationRelease } from "../services/desktop-electron-migration-release";
import {
  DESKTOP_UPDATE_MANIFEST_LOG_TYPE,
  DESKTOP_UPDATE_MANIFEST_PROVIDER,
  desktopUpdateManifestUnavailable,
  loadDesktopDmgDownloadUrl,
  loadDesktopReleasePageUrl,
  loadDesktopUpdateRelease,
  type DesktopUpdateManifestUnavailable,
} from "../services/desktop-updates.service";
import { settle } from "../utils";

const L = logger("DesktopUpdates");

/**
 * How long a client should wait before re-asking after a `503`.
 *
 * Shorter than the desktop updater's own 30-minute poll, so it never delays
 * the schedule the client already keeps; it only helps anything that retries
 * on its own.
 */
const DESKTOP_UPDATE_RETRY_AFTER_SECONDS = "60";

const releasePageParams$ = pathParamsOf(desktopUpdatesContract.releasePage);
const dmgDownloadParams$ = pathParamsOf(desktopUpdatesContract.dmgDownload);
const productFeedParams$ = pathParamsOf(desktopUpdatesContract.productFeed);
const productAppcastParams$ = pathParamsOf(
  desktopUpdatesContract.productAppcast,
);
const productReleasePageParams$ = pathParamsOf(
  desktopUpdatesContract.productReleasePage,
);
const productDmgDownloadParams$ = pathParamsOf(
  desktopUpdatesContract.productDmgDownload,
);

const getDesktopCompatibility$ = command(({ set }) => {
  set(setResHeader$, "Cache-Control", "no-store");
  return {
    status: 200 as const,
    body: { minimumSupportedVersion: desktopMinimumSupportedVersion() },
  };
});

/**
 * The update line the unqualified release-page and DMG routes serve.
 *
 * The Platform download button uses
 * `/api/desktop/updates/stable/darwin/arm64/dmg`, so these neutral routes must
 * keep resolving to the current Okou release.
 */
const UNQUALIFIED_DESKTOP_UPDATE_LINE = DESKTOP_UPDATE_LINE_OKOU;

/**
 * Settle a manifest-backed load, separating "the release host could not be
 * read" from every other failure.
 *
 * Only that one outcome is reported back; a missing or invalid manifest, a
 * bug in release selection, and a cancelled request all keep propagating to
 * the unhandled-error path, where they stay loud.
 */
async function settleManifestLoad<T>(
  load: Promise<T>,
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly unavailable: DesktopUpdateManifestUnavailable;
    }
> {
  const settled = await settle(load, signal);
  if (settled.ok) {
    return { ok: true, value: settled.value };
  }

  const unavailable = desktopUpdateManifestUnavailable(settled.error);
  if (!unavailable) {
    throw settled.error;
  }
  return { ok: false, unavailable };
}

/**
 * Answer a poll whose manifest could not be read.
 *
 * This is a classified outcome, not an unhandled error: it is logged at `info`
 * with the upstream status and attempt count and never reaches Sentry, because
 * a single one needs no intervention. A sustained rate is the real signal, and
 * this record is what carries it: `info` keeps it queryable in Axiom while
 * leaving it out of the production error review. The `503` in the request log
 * cannot stand in for it — that dataset retains only a few days, too short to
 * separate a sustained problem from scattered events.
 */
const desktopUpdateUnavailable$ = command(
  (
    { set },
    args: {
      readonly line: DesktopUpdateLine;
      readonly route: string;
      readonly unavailable: DesktopUpdateManifestUnavailable;
    },
  ) => {
    L.info("Desktop update manifest upstream unavailable", {
      type: DESKTOP_UPDATE_MANIFEST_LOG_TYPE,
      outcome: "unavailable",
      provider: DESKTOP_UPDATE_MANIFEST_PROVIDER,
      ...(args.unavailable.providerStatus === null
        ? {}
        : { provider_status: args.unavailable.providerStatus }),
      failure_class: "transient_read_exhausted",
      attempts: args.unavailable.attempts,
      line: args.line,
      method: "GET",
      route: args.route,
    });

    set(setResHeader$, "Cache-Control", "no-store");
    set(setResHeader$, "Retry-After", DESKTOP_UPDATE_RETRY_AFTER_SECONDS);
    return desktopUpdateUnavailable(
      "The desktop release manifest is temporarily unavailable. Try again shortly.",
    );
  },
);

const getDesktopReleasePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const loaded = await settleManifestLoad(
      loadDesktopReleasePageUrl(
        {
          line: UNQUALIFIED_DESKTOP_UPDATE_LINE,
          ...get(releasePageParams$),
        },
        signal,
      ),
      signal,
    );
    if (!loaded.ok) {
      return set(desktopUpdateUnavailable$, {
        line: UNQUALIFIED_DESKTOP_UPDATE_LINE,
        route: desktopUpdatesContract.releasePage.path,
        unavailable: loaded.unavailable,
      });
    }
    const url = loaded.value;
    signal.throwIfAborted();

    if (!url) {
      return notFound("No desktop release is available for this feed.");
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "no-store",
      },
    });
  },
);

const getDesktopDmgDownload$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const loaded = await settleManifestLoad(
      loadDesktopDmgDownloadUrl(
        {
          line: UNQUALIFIED_DESKTOP_UPDATE_LINE,
          ...get(dmgDownloadParams$),
        },
        signal,
      ),
      signal,
    );
    if (!loaded.ok) {
      return set(desktopUpdateUnavailable$, {
        line: UNQUALIFIED_DESKTOP_UPDATE_LINE,
        route: desktopUpdatesContract.dmgDownload.path,
        unavailable: loaded.unavailable,
      });
    }
    const url = loaded.value;
    signal.throwIfAborted();

    if (!url) {
      return notFound("No desktop DMG is available for this feed.");
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "no-store",
      },
    });
  },
);

// The `:product` handlers retain the retired pre-adoption Okou line's 404
// response for installed Electron clients; see the contract's removal boundary.

const getProductDesktopReleasePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { product, ...params } = get(productReleasePageParams$);
    if (product === DESKTOP_UPDATE_LINE_LEGACY_OKOU) {
      return notFound("This desktop update line is retired.");
    }
    const loaded = await settleManifestLoad(
      loadDesktopReleasePageUrl({ line: product, ...params }, signal),
      signal,
    );
    if (!loaded.ok) {
      return set(desktopUpdateUnavailable$, {
        line: product,
        route: desktopUpdatesContract.productReleasePage.path,
        unavailable: loaded.unavailable,
      });
    }
    const url = loaded.value;
    signal.throwIfAborted();

    if (!url) {
      return notFound("No desktop release is available for this feed.");
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "no-store",
      },
    });
  },
);

const getProductDesktopUpdateFeed$ = command(({ get, set }) => {
  const { product } = get(productFeedParams$);
  if (product === DESKTOP_UPDATE_LINE_LEGACY_OKOU) {
    return notFound("This desktop update line is retired.");
  }
  // The contract permits only stable/darwin/arm64. This hop must not advance
  // with the Native manifest, even when the manifest host is unavailable.
  const release = desktopElectronMigrationRelease;
  set(setResHeader$, "Cache-Control", "no-store");
  return {
    status: 200 as const,
    body: {
      currentRelease: release.version,
      releases: [
        {
          version: release.version,
          updateTo: {
            name: release.name,
            version: release.version,
            pub_date: release.pubDate,
            notes: release.notes,
            url: release.url,
          },
        },
      ],
    } satisfies SquirrelMacReleases,
  };
});

function xmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": {
        return "&amp;";
      }
      case "<": {
        return "&lt;";
      }
      case ">": {
        return "&gt;";
      }
      case '"': {
        return "&quot;";
      }
      case "'": {
        return "&apos;";
      }
      default: {
        throw new Error("Unexpected XML character");
      }
    }
  });
}

const getProductDesktopAppcast$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { product, ...params } = get(productAppcastParams$);
    if (product !== DESKTOP_UPDATE_LINE_OKOU) {
      return notFound("This desktop update line is retired.");
    }
    const loaded = await settleManifestLoad(
      loadDesktopUpdateRelease({ line: product, ...params }, signal),
      signal,
    );
    if (!loaded.ok) {
      return set(desktopUpdateUnavailable$, {
        line: product,
        route: desktopUpdatesContract.productAppcast.path,
        unavailable: loaded.unavailable,
      });
    }
    signal.throwIfAborted();
    if (!loaded.value) {
      return notFound("No desktop update is available for this feed.");
    }
    // ZIP bundles are authenticated by Sparkle against the installed app's
    // Developer ID designated requirement (same trust boundary as Squirrel).
    const minimum = desktopMinimumSupportedVersion();
    const release = loaded.value;
    const item = `<item>
      <title>${xmlText(release.name)}</title>
      <pubDate>${xmlText(new Date(release.pubDate).toUTCString())}</pubDate>
      <description>${xmlText(release.notes)}</description>
      <sparkle:version>${xmlText(release.version)}</sparkle:version>
      <sparkle:shortVersionString>${xmlText(release.version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      ${minimum !== null && desktopVersionIsSupported(release.version, minimum) ? `<sparkle:criticalUpdate sparkle:version="${xmlText(minimum)}"/>` : ""}
      <enclosure url="${xmlText(release.url)}" type="application/octet-stream"/>
    </item>`;
    return new Response(
      `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<title>Okou Desktop</title>${item}</channel></rss>`,
      {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  },
);

const getProductDesktopDmgDownload$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { product, ...params } = get(productDmgDownloadParams$);
    if (product === DESKTOP_UPDATE_LINE_LEGACY_OKOU) {
      return notFound("This desktop update line is retired.");
    }
    const loaded = await settleManifestLoad(
      loadDesktopDmgDownloadUrl({ line: product, ...params }, signal),
      signal,
    );
    if (!loaded.ok) {
      return set(desktopUpdateUnavailable$, {
        line: product,
        route: desktopUpdatesContract.productDmgDownload.path,
        unavailable: loaded.unavailable,
      });
    }
    const url = loaded.value;
    signal.throwIfAborted();

    if (!url) {
      return notFound("No desktop DMG is available for this feed.");
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "no-store",
      },
    });
  },
);

export const desktopUpdateRoutes: readonly RouteEntry[] = [
  {
    route: desktopUpdatesContract.compatibility,
    handler: getDesktopCompatibility$,
  },
  {
    route: desktopUpdatesContract.productAppcast,
    handler: getProductDesktopAppcast$,
  },
  {
    route: desktopUpdatesContract.releasePage,
    handler: getDesktopReleasePage$,
  },
  {
    route: desktopUpdatesContract.dmgDownload,
    handler: getDesktopDmgDownload$,
  },
  {
    route: desktopUpdatesContract.productReleasePage,
    handler: getProductDesktopReleasePage$,
  },
  {
    route: desktopUpdatesContract.productDmgDownload,
    handler: getProductDesktopDmgDownload$,
  },
  {
    route: desktopUpdatesContract.productFeed,
    handler: getProductDesktopUpdateFeed$,
  },
];
