import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { i18n } from "../../i18n/index.ts";
import { PermissionBatchPage } from "../../views/permission-allow/permission-batch-page.tsx";
import { createPermissionBatchSignals } from "../chat-page/permission-batch-signals.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import {
  permissionBatchPageDescriptor$,
  setPermissionBatchPageSignals$,
} from "./permission-batch-page-signals.ts";

export const setupPermissionBatchPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const features = await get(featureSwitch$);
    signal.throwIfAborted();
    const descriptor = features[FeatureSwitchKey.BatchConnectorPermissions]
      ? get(permissionBatchPageDescriptor$)
      : null;
    set(
      setPermissionBatchPageSignals$,
      descriptor ? createPermissionBatchSignals(descriptor) : null,
    );
    set(updatePage$, createElement(PermissionBatchPage), "standalone");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.permissions.permissions;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
