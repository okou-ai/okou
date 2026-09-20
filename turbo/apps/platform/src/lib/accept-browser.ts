import { CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES } from "@okouai/api-contracts/contracts/custom-connectors";
import { toast } from "@okouai/ui/components/ui/sonner";

import { i18n } from "../i18n/index.ts";
import { localizedSshError } from "./ssh-error.ts";
import { localizedVncError } from "./vnc-error.ts";
import { ACCEPT_ERROR_EVENT, type AcceptErrorEventDetail } from "./accept.ts";

function localizedAutomaticMcpOAuthError(code: string): string | undefined {
  switch (code) {
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHENTICATION_RESPONSE_INVALID: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.authenticationResponseInvalid;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.discoveryInvalid;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHORIZATION_UNSUPPORTED: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.authorizationUnsupported;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_UNAVAILABLE: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.clientRegistrationUnavailable;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_REJECTED: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.clientRegistrationRejected;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_INVALID: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.clientRegistrationInvalid;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_CONFLICT: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.clientRegistrationConflict;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.UNSAFE_URL: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.unsafeUrl;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.providerUnavailable;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.BINDING_CHANGED: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.bindingChanged;
      });
    }
    default: {
      return undefined;
    }
  }
}

globalThis.addEventListener(ACCEPT_ERROR_EVENT, (event) => {
  if (!(event instanceof CustomEvent)) {
    return;
  }
  const detail = event.detail as AcceptErrorEventDetail;
  if (detail.kind === "http-status") {
    detail.message = i18n.t(
      ($) => {
        return $.global.errors.httpStatus;
      },
      { status: detail.status ?? 0 },
    );
  } else if (detail.kind === "request-failed") {
    detail.message = i18n.t(($) => {
      return $.global.errors.requestFailed;
    });
  } else if (detail.code) {
    detail.message =
      localizedSshError(detail.code) ??
      localizedVncError(detail.code) ??
      localizedAutomaticMcpOAuthError(detail.code) ??
      detail.message;
  }
  if (detail.show && detail.message) {
    toast.error(detail.message);
  }
});
