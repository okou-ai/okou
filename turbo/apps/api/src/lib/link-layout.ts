import type { LinkLayout } from "@okouai/api-contracts/contracts/link-layout";

import { env } from "./env";

export function hostedLinkDomain(layout: LinkLayout): string {
  return layout === "current"
    ? env("OKOU_PUBLIC_HOST_DOMAIN")
    : env("ZERO_HOST_DOMAIN");
}

export function hostedLinkScheme(layout: LinkLayout): string {
  return layout === "current"
    ? env("OKOU_HOST_SCHEME")
    : env("ZERO_HOST_SCHEME");
}

/** Origin of a hosted-site or share host label in the given layout. */
export function hostedLinkOrigin(layout: LinkLayout, label: string): string {
  return `${hostedLinkScheme(layout)}://${label}.${hostedLinkDomain(layout)}`;
}
