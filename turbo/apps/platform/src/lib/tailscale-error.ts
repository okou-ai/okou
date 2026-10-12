import { TAILSCALE_ERROR_CODES } from "@okouai/api-contracts/contracts/tailscale-errors";
import { i18n } from "../i18n/index.ts";

export function localizedTailscaleError(code: string): string | undefined {
  switch (code) {
    case TAILSCALE_ERROR_CODES.NOT_FOUND: {
      return i18n.t(($) => {
        return $.tailscale.missing;
      });
    }
    case TAILSCALE_ERROR_CODES.FORBIDDEN: {
      return i18n.t(($) => {
        return $.tailscale.forbidden;
      });
    }
    case TAILSCALE_ERROR_CODES.IN_USE: {
      return i18n.t(($) => {
        return $.tailscale.inUse;
      });
    }
    case TAILSCALE_ERROR_CODES.REVISION_CONFLICT: {
      return i18n.t(($) => {
        return $.tailscale.changed;
      });
    }
    case TAILSCALE_ERROR_CODES.IMPACT_CONFLICT: {
      return i18n.t(($) => {
        return $.cloudflareAccess.impactChanged;
      });
    }
    case TAILSCALE_ERROR_CODES.RESOURCE_ID_CONFLICT: {
      return i18n.t(($) => {
        return $.cloudflareAccess.resourceIdConflict;
      });
    }
    case TAILSCALE_ERROR_CODES.REVISION_EXHAUSTED: {
      return i18n.t(($) => {
        return $.cloudflareAccess.revisionExhausted;
      });
    }
    case "invalid":
    case "INVALID_INPUT": {
      return i18n.t(($) => {
        return $.tailscale.invalid;
      });
    }
    case "uncertain": {
      return i18n.t(($) => {
        return $.tailscale.uncertain;
      });
    }
    default: {
      return undefined;
    }
  }
}
