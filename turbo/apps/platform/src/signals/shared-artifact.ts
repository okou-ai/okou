import { command, computed } from "ccstate";
import { createElement } from "react";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { z } from "zod";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../lib/accept.ts";
import { i18n } from "../i18n/index.ts";
import { clerk$ } from "./auth.ts";
import { apiClient$ } from "./api-client.ts";
import { pathParams$ } from "./route.ts";
import { updatePage$ } from "./react-router.ts";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import { featureSwitches$ } from "./external/feature-switch.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import {
  createSharedArtifactPreview,
  createSharedArtifactViewerSignals,
  type SharedArtifactContent,
} from "./shared-artifact-page.ts";
import { SharedArtifactPage } from "../views/shared-artifact-page/shared-artifact-page.tsx";

const sharedArtifactViewer$ = computed((get) => {
  get(pathParams$);
  return createSharedArtifactViewerSignals();
});

const resolveSharedArtifact$ = command(
  async (
    { get },
    reference: string,
    signedIn: boolean,
    signal: AbortSignal,
  ): Promise<SharedArtifactContent | null> => {
    if (signedIn) {
      const result = await accept(
        get(apiClient$)(artifactReferencesContract).resolve({
          params: { reference },
          fetchOptions: { signal, cache: "no-store" },
        }),
        [200, 400, 401, 403, 404],
        signal,
      );
      if (result.status === 200) {
        return result.body;
      }
    }
    const result = await accept(
      get(apiClient$)(artifactReferencesContract, {
        getToken: () => {
          return Promise.resolve(null);
        },
      }).publicUrl({
        params: { reference },
        fetchOptions: { signal, cache: "no-store" },
      }),
      [200, 400, 404],
      signal,
    );
    if (result.status !== 200) {
      return null;
    }
    return {
      ...result.body.preview,
      url: result.body.url,
      expiresAt: result.body.expiresAt,
      sharedThreadSnapshot: result.body.sharedThreadSnapshot,
    };
  },
);

// This route owns access checks so signed-out visitors can preview public
// artifacts and choose when to sign in for unavailable ones.
export const setupSharedArtifact$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const requestedId = String(get(pathParams$)?.artifactShareId ?? "");
    const legacyId = z.uuid().safeParse(requestedId);
    const id = legacyId.success
      ? artifactReferencePath(legacyId.data).slice("/artifacts/".length)
      : requestedId;
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.loaded) {
      return;
    }
    const content = await set(
      resolveSharedArtifact$,
      id,
      Boolean(clerk.user),
      signal,
    );
    if (
      content?.expiresAt !== undefined &&
      content.sharedThreadSnapshot !== true
    ) {
      const switches = await get(featureSwitches$);
      signal.throwIfAborted();
      if (!switches[FeatureSwitchKey.PrivateArtifacts]) {
        const contentUrl = new URL(content.url);
        contentUrl.hash = location.hash;
        window.location.replace(contentUrl.href);
        return;
      }
    }
    const referenceUrl = new URL(
      `/artifacts/${encodeURIComponent(id)}`,
      location.origin,
    );
    referenceUrl.hash = location.hash;
    const artifact = content
      ? createSharedArtifactPreview(content, referenceUrl.href)
      : null;
    set(
      updateDocumentTitle$,
      artifact?.filename ??
        i18n.t(($) => {
          return $.artifacts.title;
        }),
    );
    set(
      updatePage$,
      createElement(SharedArtifactPage, {
        key: id,
        artifact,
        viewer: get(sharedArtifactViewer$),
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
