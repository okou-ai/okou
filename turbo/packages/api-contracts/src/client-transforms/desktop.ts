import type { ClientResponseTransform } from "./types";

/**
 * Response transforms for installed Desktop builds that still decode an older
 * response shape. The runtime API compatibility lint accepts a matching entry
 * as proof for a breaking change on a Desktop-consumed route; see
 * docs/deployment-compatibility.md#desktop-contract-gate.
 */
export const desktopResponseTransforms: readonly ClientResponseTransform[] = [];
