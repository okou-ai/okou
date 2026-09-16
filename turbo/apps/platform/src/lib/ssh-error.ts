import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { i18n } from "../i18n/index.ts";

export function localizedSshError(code: string): string | undefined {
  switch (code) {
    case SSH_ERROR_CODES.RESOURCE_ID_CONFLICT: {
      return i18n.t(($) => {
        return $.ssh.saveRecovery.resourceIdConflict;
      });
    }
    case SSH_ERROR_CODES.ACCESS_UNAVAILABLE: {
      return i18n.t(($) => {
        return $.ssh.cloudflare.unavailable;
      });
    }
    case SSH_ERROR_CODES.ACCESS_NOT_FOUND: {
      return i18n.t(($) => {
        return $.ssh.cloudflare.missing;
      });
    }
    case SSH_ERROR_CODES.ACCESS_IN_USE: {
      return i18n.t(($) => {
        return $.ssh.cloudflare.inUse;
      });
    }
    case SSH_ERROR_CODES.ACCESS_REVISION_CONFLICT: {
      return i18n.t(($) => {
        return $.ssh.cloudflare.changed;
      });
    }
    case SSH_ERROR_CODES.CREDENTIAL_NOT_FOUND: {
      return i18n.t(($) => {
        return $.ssh.errors.credentialUnavailable;
      });
    }
    case SSH_ERROR_CODES.CREDENTIAL_IN_USE: {
      return i18n.t(($) => {
        return $.ssh.errors.credentialInUse;
      });
    }
    case SSH_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT: {
      return i18n.t(($) => {
        return $.ssh.errors.credentialChanged;
      });
    }
    case SSH_ERROR_CODES.REVISION_EXHAUSTED: {
      return i18n.t(($) => {
        return $.ssh.errors.revisionExhausted;
      });
    }
    case SSH_ERROR_CODES.UNAVAILABLE: {
      return i18n.t(($) => {
        return $.ssh.unavailable;
      });
    }
    case SSH_ERROR_CODES.AGENT_UNAVAILABLE: {
      return i18n.t(($) => {
        return $.ssh.errors.agentUnavailable;
      });
    }
    case SSH_ERROR_CODES.INVALID_INPUT: {
      return i18n.t(($) => {
        return $.ssh.errors.invalidInput;
      });
    }
    case SSH_ERROR_CODES.INVALID_HOST: {
      return i18n.t(($) => {
        return $.ssh.errors.invalidHost;
      });
    }
    case SSH_ERROR_CODES.CONNECTION_NOT_FOUND: {
      return i18n.t(($) => {
        return $.ssh.errors.hostUnavailable;
      });
    }
    case SSH_ERROR_CODES.GENERATION_CONFLICT: {
      return i18n.t(($) => {
        return $.ssh.errors.configurationChanged;
      });
    }
    default: {
      return undefined;
    }
  }
}
