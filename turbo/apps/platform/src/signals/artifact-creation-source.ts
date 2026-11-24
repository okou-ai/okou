import { command, computed, state } from "ccstate";
import { artifactCatalogContract } from "@okouai/api-contracts/client/artifact-catalog";
import type { ArtifactCreationSource } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "./api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "./auth.ts";
import { featureSwitches$ } from "./external/feature-switch.ts";
import { onRef, resetSignal } from "./utils.ts";

/** A single open catalog menu owns its lookup; closing never caches a target. */
function createArtifactCreationSourceScope() {
  const request$ = state<{
    readonly artifactId: string;
    readonly actor: string;
    readonly read: (
      client: ApiClientFactory,
    ) => Promise<ArtifactCreationSource | null>;
  } | null>(null);
  const resetMenuSignal$ = resetSignal();
  const close$ = command(({ set }) => {
    set(resetMenuSignal$);
    set(request$, null);
  });
  const open$ = command(
    async ({ get, set }, artifactId: string, parentSignal: AbortSignal) => {
      const signal = set(resetMenuSignal$, parentSignal);
      signal.throwIfAborted();
      const actor = get(authenticatedSessionKey$);
      set(request$, null);
      if (!actor) {
        return;
      }
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      if (get(authenticatedSessionKey$) !== actor) {
        set(close$);
        return;
      }
      const unsubscribe = clerk.addListener(
        () => {
          const currentActor =
            clerk.user && clerk.organization && clerk.session
              ? JSON.stringify([
                  clerk.organization.id,
                  clerk.user.id,
                  clerk.session.id,
                ])
              : null;
          if (currentActor !== actor) {
            set(close$);
          }
        },
        { skipInitialEmit: true },
      );
      signal.addEventListener("abort", unsubscribe, { once: true });
      signal.addEventListener(
        "abort",
        () => {
          set(request$, null);
        },
        { once: true },
      );
      set(request$, {
        artifactId,
        actor,
        read: async (client) => {
          signal.throwIfAborted();
          const result = await accept(
            client(artifactCatalogContract).creationSource({
              params: { artifactId },
              fetchOptions: { cache: "no-store", signal },
            }),
            [200, 401, 403, 404],
            signal,
          );
          signal.throwIfAborted();
          return result.status === 200 ? result.body.source : null;
        },
      });
    },
  );
  const mountMenu$ = command(
    ({ set }, _element: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener(
        "abort",
        () => {
          set(close$);
        },
        { once: true },
      );
    },
  );
  return {
    open$,
    close$,
    menuRef$: onRef(mountMenu$),
    source$: computed(async (get) => {
      const request = get(request$);
      const actor = get(authenticatedSessionKey$);
      if (!request || request.actor !== actor) {
        return null;
      }
      const features = await get(featureSwitches$);
      if (!features[FeatureSwitchKey.ArtifactLibrary]) {
        return null;
      }
      const source = await request.read(get(apiClient$));
      return { artifactId: request.artifactId, source };
    }),
  };
}

export type ArtifactCreationSourceScope = ReturnType<
  typeof createArtifactCreationSourceScope
>;
export const artifactRowCreationSource = createArtifactCreationSourceScope();
export const artifactSidebarCreationSource =
  createArtifactCreationSourceScope();
