import {
  DESKTOP_UPDATE_LINE_LEGACY_OKOU,
  DESKTOP_UPDATE_LINE_OKOU,
  DESKTOP_UPDATE_LINE_ZERO,
  desktopUpdatesContract,
  type DesktopUpdateLine,
  type DesktopZeroMigrationPolicy,
} from "@okouai/api-contracts/contracts/desktop-updates";
import { command } from "ccstate";

import { desktopUpdateUnavailable, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  DESKTOP_UPDATE_MANIFEST_LOG_TYPE,
  DESKTOP_UPDATE_MANIFEST_PROVIDER,
  desktopUpdateManifestUnavailable,
  loadDesktopDmgDownloadUrl,
  loadDesktopReleasePageUrl,
  loadDesktopUpdateFeed,
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
const productReleasePageParams$ = pathParamsOf(
  desktopUpdatesContract.productReleasePage,
);
const productDmgDownloadParams$ = pathParamsOf(
  desktopUpdatesContract.productDmgDownload,
);

/**
 * The Zero Desktop migration policy this service serves.
 *
 * The policy used to be fetched from a GitHub release asset on every poll so
 * that it could be flipped without a deploy. `hard` was activated and verified
 * on 2026-08-31 and the owner confirmed it will not be rolled back, so the
 * mechanism is gone and the policy now changes only by editing this constant
 * and deploying.
 *
 * The endpoint itself has to stay: both this route and the desktop client fail
 * open to `soft`, so removing it would silently un-block every installed Zero
 * build that still polls.
 */
const DESKTOP_ZERO_MIGRATION_POLICY = {
  schemaVersion: 1,
  mode: "hard",
} as const satisfies DesktopZeroMigrationPolicy;

const getDesktopMigrationPolicy$ = command(({ set }) => {
  set(setResHeader$, "Cache-Control", "no-store");
  return {
    status: 200 as const,
    body: DESKTOP_ZERO_MIGRATION_POLICY,
  };
});

/**
 * The update line the unqualified release-page and DMG routes serve.
 *
 * `/api/desktop/updates/stable/darwin/arm64/dmg` is what the migration wall's
 * `Download Okou` button opens and what the bridge compiled into installed Zero
 * builds hard-codes, so this constant must keep resolving to the current Okou
 * DMG. Both the platform download button and the supported Zero migration
 * bridge depend on that current artifact.
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

// All three `:product` handlers below reject the same retired lines. `okou` is
// the pre-adoption Okou line. `zero` joined it in #31475: its manifest had been
// frozen since the `hard` migration policy went live, and the only clients left
// polling it were Squirrel auto-updaters that cannot cross from the Zero bundle
// to the Okou one, so the feed could not upgrade anyone. Neither line is
// removed from the contract union — see the note there.

const getProductDesktopReleasePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { product, ...params } = get(productReleasePageParams$);
    if (
      product === DESKTOP_UPDATE_LINE_LEGACY_OKOU ||
      product === DESKTOP_UPDATE_LINE_ZERO
    ) {
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

const getProductDesktopUpdateFeed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { product, ...params } = get(productFeedParams$);
    if (
      product === DESKTOP_UPDATE_LINE_LEGACY_OKOU ||
      product === DESKTOP_UPDATE_LINE_ZERO
    ) {
      return notFound("This desktop update line is retired.");
    }
    const loaded = await settleManifestLoad(
      loadDesktopUpdateFeed({ line: product, ...params }, signal),
      signal,
    );
    if (!loaded.ok) {
      return set(desktopUpdateUnavailable$, {
        line: product,
        route: desktopUpdatesContract.productFeed.path,
        unavailable: loaded.unavailable,
      });
    }
    const feed = loaded.value;
    signal.throwIfAborted();

    if (!feed) {
      return notFound("No desktop update is available for this feed.");
    }

    return {
      status: 200 as const,
      body: feed,
    };
  },
);

const getProductDesktopDmgDownload$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const { product, ...params } = get(productDmgDownloadParams$);
    if (
      product === DESKTOP_UPDATE_LINE_LEGACY_OKOU ||
      product === DESKTOP_UPDATE_LINE_ZERO
    ) {
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
    route: desktopUpdatesContract.migrationPolicy,
    handler: getDesktopMigrationPolicy$,
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
