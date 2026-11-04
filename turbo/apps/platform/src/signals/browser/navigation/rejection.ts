import { CdpFault } from "../cdp/errors.ts";

/** Native text can contain destinations. Retain only exact, fixed reasons. */
function navigationReason(errorText: unknown) {
  switch (errorText) {
    case "net::ERR_ABORTED":
    case "net::ERR_BLOCKED_BY_CLIENT":
    case "net::ERR_BLOCKED_BY_ADMINISTRATOR":
    case "net::ERR_NAME_NOT_RESOLVED":
    case "net::ERR_INTERNET_DISCONNECTED":
    case "net::ERR_TIMED_OUT":
    case "net::ERR_CONNECTION_TIMED_OUT":
    case "net::ERR_CONNECTION_CLOSED":
    case "net::ERR_CONNECTION_RESET":
    case "net::ERR_CONNECTION_REFUSED":
    case "net::ERR_SSL_PROTOCOL_ERROR":
    case "net::ERR_CERT_AUTHORITY_INVALID":
    case "net::ERR_CERT_DATE_INVALID":
    case "net::ERR_CERT_COMMON_NAME_INVALID": {
      return errorText;
    }
    default: {
      return "unknown";
    }
  }
}

/** A fulfilled Page.navigate receipt that reports a failed navigation. */
export class NativeNavigationFault extends CdpFault {
  readonly reason: ReturnType<typeof navigationReason>;

  constructor(errorText: unknown) {
    const reason = navigationReason(errorText);
    super(
      "input",
      `The remote page could not be navigated (${reason}).`,
      undefined,
      Object.freeze({ method: "Page.navigate" }),
    );
    this.name = "NativeNavigationFault";
    this.reason = reason;
  }

  get expected(): boolean {
    return (
      this.reason === "net::ERR_ABORTED" ||
      this.reason === "net::ERR_BLOCKED_BY_CLIENT" ||
      this.reason === "net::ERR_BLOCKED_BY_ADMINISTRATOR"
    );
  }
}
