import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
import { i18n } from "../i18n/index.ts";

export function localizedVncError(code: string): string | undefined {
  switch (code) {
    case VNC_ERROR_CODES.UNAVAILABLE: {
      return i18n.t(($) => {
        return $.vnc.unavailable;
      });
    }
    case VNC_ERROR_CODES.INVALID_INPUT: {
      return i18n.t(($) => {
        return $.vnc.errors.invalidInput;
      });
    }
    case VNC_ERROR_CODES.INVALID_HOST: {
      return i18n.t(($) => {
        return $.vnc.errors.invalidHost;
      });
    }
    case VNC_ERROR_CODES.INVALID_TRUST: {
      return i18n.t(($) => {
        return $.vnc.errors.invalidTrust;
      });
    }
    case VNC_ERROR_CODES.CREDENTIAL_NOT_FOUND: {
      return i18n.t(($) => {
        return $.vnc.errors.credentialUnavailable;
      });
    }
    case VNC_ERROR_CODES.CREDENTIAL_IN_USE: {
      return i18n.t(($) => {
        return $.vnc.credential.inUse;
      });
    }
    case VNC_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT: {
      return i18n.t(($) => {
        return $.vnc.errors.credentialChanged;
      });
    }
    case VNC_ERROR_CODES.CONNECTION_NOT_FOUND: {
      return i18n.t(($) => {
        return $.vnc.errors.hostUnavailable;
      });
    }
    case VNC_ERROR_CODES.GENERATION_CONFLICT: {
      return i18n.t(($) => {
        return $.vnc.errors.configurationChanged;
      });
    }
    case VNC_ERROR_CODES.RESOURCE_ID_CONFLICT: {
      return i18n.t(($) => {
        return $.vnc.saveRecovery.resourceIdConflict;
      });
    }
    case VNC_ERROR_CODES.REVISION_EXHAUSTED: {
      return i18n.t(($) => {
        return $.vnc.errors.revisionExhausted;
      });
    }
    case VNC_ERROR_CODES.OWNER_CHANGED: {
      return i18n.t(($) => {
        return $.vnc.errors.ownerChanged;
      });
    }
    default: {
      return undefined;
    }
  }
}
