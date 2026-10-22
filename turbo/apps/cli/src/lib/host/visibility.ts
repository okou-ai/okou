import {
  hostedSiteVisibilitySchema,
  type HostedSiteVisibility,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import { decodeSandboxTokenPayload } from "../api/sandbox-token";

export const hostedSiteAudiences = {
  "only-me": "private",
  org: "organization",
  public: "public",
} as const satisfies Record<string, HostedSiteVisibility>;

export type HostedSiteCliVisibility = keyof typeof hostedSiteAudiences;

const hostedSiteVisibilities = {
  private: "only-me",
  organization: "org",
  public: "public",
} as const satisfies Record<HostedSiteVisibility, HostedSiteCliVisibility>;

export function acknowledgeHostedSiteVisibility(
  requested: HostedSiteCliVisibility | undefined,
  received: unknown,
): { readonly visibility?: HostedSiteCliVisibility } {
  const visibility = hostedSiteVisibilitySchema.safeParse(received);
  if (
    (hostedSiteVisibilityEnabled() && !visibility.success) ||
    (requested !== undefined && received !== hostedSiteAudiences[requested])
  ) {
    throw new Error(
      "The API did not acknowledge the site visibility; no files were uploaded or activated. Retry after the API supports hosted-site visibility.",
    );
  }
  return visibility.success
    ? { visibility: hostedSiteVisibilities[visibility.data] }
    : {};
}

export function hostedSiteVisibilityEnabled(): boolean {
  return (
    decodeSandboxTokenPayload()?.capabilities.includes(
      "host-visibility:write",
    ) ?? false
  );
}

export function assertHostedSiteVisibilityEnabled(): void {
  if (!hostedSiteVisibilityEnabled()) {
    throw new Error(
      "--visibility requires hostedSiteVisibility to be enabled. Start a new run after enabling it.",
    );
  }
}

export function hostedSiteVisibilityInstructions(): string {
  return hostedSiteVisibilityEnabled()
    ? "New hosted sites default to only-me. Redeployments keep the site's visibility unless --visibility is supplied."
    : "Hosted sites are public: anyone with the returned URL can open them";
}
