import { command } from "ccstate";
import { artifactOgContract } from "@okouai/api-contracts/contracts/artifact-og";
import { setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  artifactOgMetadata$,
  artifactOgImage$,
  defaultArtifactOgImage,
} from "../services/artifact-og.service";

const noStore$ = command(({ set }) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  set(setResHeader$, "CDN-Cache-Control", "no-store");
  set(setResHeader$, "Cloudflare-CDN-Cache-Control", "no-store");
  set(setResHeader$, "X-Content-Type-Options", "nosniff");
  set(setResHeader$, "Referrer-Policy", "no-referrer");
});

function imageResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": "image/png" },
  });
}

export const artifactOgRoutes: readonly RouteEntry[] = [
  {
    route: artifactOgContract.metadata,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      set(noStore$);
      return {
        status: 200 as const,
        body: await set(
          artifactOgMetadata$,
          get(queryOf(artifactOgContract.metadata)),
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
      const bytes = await set(artifactOgImage$, query, query.version, signal);
      return imageResponse(bytes);
    }),
  },
  {
    route: artifactOgContract.defaultImage,
    handler: command(async ({ set }, signal: AbortSignal) => {
      set(noStore$);
      const bytes = await defaultArtifactOgImage();
      signal.throwIfAborted();
      return imageResponse(bytes);
    }),
  },
];
