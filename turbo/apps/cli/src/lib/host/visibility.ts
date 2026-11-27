import {
  hostedSiteVisibilitySchema,
  type HostedSiteVisibility,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import { artifactShareEmailSchema } from "@okouai/api-contracts/validators/artifact-access";
import { hostedSitePublicSlugSchema } from "@okouai/api-contracts/contracts/host";
import {
  getHostedSiteVisibility,
  shareHostedSiteByEmail,
  updateHostedSiteVisibility,
  type HostedSiteShare,
} from "../api/domains/hosted-site-sharing";

export const hostedSiteAudiences = {
  "only-me": "private",
  org: "organization",
  public: "public",
  email: "private",
} as const satisfies Record<string, HostedSiteVisibility>;

export type HostedSiteCliVisibility = keyof typeof hostedSiteAudiences;

const hostedSiteVisibilities = {
  private: "only-me",
  organization: "org",
  public: "public",
} as const satisfies Record<HostedSiteVisibility, HostedSiteCliVisibility>;

export function hostedSiteCliVisibility(visibility: HostedSiteVisibility) {
  return hostedSiteVisibilities[visibility];
}

export function hostedSiteEmailRecipients(
  visibility: HostedSiteCliVisibility | undefined,
  values: readonly string[] = [],
): readonly string[] {
  if (visibility !== "email") {
    if (values.length > 0) {
      throw new Error("--email requires email visibility");
    }
    return [];
  }
  if (values.length === 0) {
    throw new Error("Email visibility requires at least one --email address");
  }
  return [
    ...new Set(
      values.map((value) => {
        const email = artifactShareEmailSchema.safeParse(value);
        if (!email.success) {
          throw new Error(
            `Use a complete email address with --email: ${value}`,
          );
        }
        return email.data;
      }),
    ),
  ];
}

/** A failed request may have committed; leave recovery to an explicit command. */
export async function shareHostedSitePrivately(
  slug: string,
  emails: readonly string[],
  expectedSiteId?: string,
) {
  const publicSlug = hostedSitePublicSlugSchema.parse(slug);
  const current = await getHostedSiteVisibility(publicSlug);
  if (expectedSiteId !== undefined && current.siteId !== expectedSiteId) {
    throw new Error(
      "The website URL no longer points to this deployment's site",
    );
  }
  const shares: HostedSiteShare[] = [];
  try {
    const status = await updateHostedSiteVisibility(current, "private");
    for (const email of emails) {
      shares.push(
        await shareHostedSiteByEmail(
          status.artifactId ?? current.siteId,
          email,
        ),
      );
    }
    return { status, shares };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const remaining = emails.slice(shares.length);
    const args = remaining
      .map((address) => {
        return `--email '${address.replaceAll("'", "'\"'\"'")}'`;
      })
      .join(" ");
    throw new Error(
      `Email sharing could not be completed for ${publicSlug}: ${reason}. Confirmed invitations: ${JSON.stringify(
        shares.map((share) => {
          return share.email;
        }),
      )}. Remaining invitations are unconfirmed; no automatic retry was made.\nCheck the site's Share menu before retrying:\n  okou host visibility ${publicSlug} email ${args}\nDo not republish the website.`,
      { cause },
    );
  }
}

export function acknowledgeHostedSiteVisibility(
  requested: HostedSiteCliVisibility | undefined,
  received: unknown,
): { readonly visibility: HostedSiteCliVisibility } {
  const visibility = hostedSiteVisibilitySchema.safeParse(received);
  if (
    !visibility.success ||
    (requested !== undefined && received !== hostedSiteAudiences[requested])
  ) {
    throw new Error(
      "The API did not acknowledge the site visibility; no files were uploaded or activated. Retry after the API supports hosted-site visibility.",
    );
  }
  return {
    visibility:
      requested === "email" ? "email" : hostedSiteVisibilities[visibility.data],
  };
}

export const hostedSiteVisibilityInstructions =
  "New hosted sites default to only-me. Redeployments keep the site's visibility unless --visibility is supplied. Email visibility requires --email and keeps general access private. Existing email invitations and grants survive audience changes.";
