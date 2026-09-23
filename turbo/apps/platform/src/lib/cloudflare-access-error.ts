import { CLOUDFLARE_ACCESS_ERROR_CODES } from "@okouai/api-contracts/contracts/cloudflare-access-errors";

import { i18n } from "../i18n/index.ts";

export function localizedCloudflareAccessError(
  code: string,
): string | undefined {
  switch (code) {
    case CLOUDFLARE_ACCESS_ERROR_CODES.UNAVAILABLE: {
      return i18n.t(($) => {
        return $.cloudflareAccess.unavailable;
      });
    }
    case CLOUDFLARE_ACCESS_ERROR_CODES.RESOURCE_ID_CONFLICT: {
      return i18n.t(($) => {
        return $.cloudflareAccess.resourceIdConflict;
      });
    }
    case CLOUDFLARE_ACCESS_ERROR_CODES.NOT_FOUND: {
      return i18n.t(($) => {
        return $.cloudflareAccess.missing;
      });
    }
    case CLOUDFLARE_ACCESS_ERROR_CODES.IN_USE: {
      return i18n.t(($) => {
        return $.cloudflareAccess.inUse;
      });
    }
    case CLOUDFLARE_ACCESS_ERROR_CODES.REVISION_CONFLICT: {
      return i18n.t(($) => {
        return $.cloudflareAccess.changed;
      });
    }
    case CLOUDFLARE_ACCESS_ERROR_CODES.REVISION_EXHAUSTED: {
      return i18n.t(($) => {
        return $.cloudflareAccess.revisionExhausted;
      });
    }
    default: {
      return undefined;
    }
  }
}
