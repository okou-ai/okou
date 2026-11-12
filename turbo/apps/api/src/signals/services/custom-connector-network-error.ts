/** Local network authority failures are not application OAuth failures. */
export class CustomConnectorNetworkError extends Error {
  constructor(readonly reason: "changed" | "unavailable" | "scope") {
    super(
      reason === "changed"
        ? "Custom connector network authority changed; check the connector and retry explicitly"
        : reason === "scope"
          ? "The request is outside the custom connector's allowed network scope"
          : "Custom connector network authentication is unavailable",
    );
    this.name = "CustomConnectorNetworkError";
  }
}
