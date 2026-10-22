import { command } from "ccstate";
import { ARTIFACT_OG_BRAND } from "@okouai/core/artifact-og";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  artifactOgMetadata$,
  artifactOgImage$,
} from "../services/artifact-og.service";
import { slackPreviewImage$ } from "../services/slack-preview-image.service";

const noStore$ = command(({ set }) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  set(setResHeader$, "CDN-Cache-Control", "no-store");
  set(setResHeader$, "Cloudflare-CDN-Cache-Control", "no-store");
  set(setResHeader$, "X-Content-Type-Options", "nosniff");
  set(setResHeader$, "Referrer-Policy", "no-referrer");
});

function imageResponse(url: string | null): Response {
  if (url === null) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: ARTIFACT_OG_BRAND.imageUrl,
      },
    });
  }
  return new Response(null, { status: 302, headers: { Location: url } });
}

export const artifactOgRoutes: readonly RouteEntry[] = [
  {
    route: artifactOgContract.slackImage,
    handler: command(({ get, set }, signal: AbortSignal) => {
      set(noStore$);
      const url = set(
        slackPreviewImage$,
        get(queryOf(artifactOgContract.slackImage)),
        signal,
      );
      return url
        ? new Response(null, { status: 302, headers: { Location: url } })
        : new Response(null, { status: 403 });
    }),
  },
  {
    route: artifactOgContract.metadata,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      set(noStore$);
      return {
        status: 200 as const,
        body: await set(
          artifactOgMetadata$,
          get(queryOf(artifactOgContract.metadata)),
          undefined,
          signal,
        ),
      };
    }),
  },
  {
    route: artifactOgContract.image,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      set(noStore$);
      const query = get(queryOf(artifactOgContract.image));
      const url = await set(artifactOgImage$, query, query.version, signal);
      return imageResponse(url);
    }),
  },
  {
    route: artifactOgContract.defaultImage,
    handler: command(({ set }) => {
      set(noStore$);
      return imageResponse(null);
    }),
  },
];
