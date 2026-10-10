import { command, computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ArtifactDeliveryRecord } from "@okouai/api-contracts/contracts/artifact-delivery";
import type { ArtifactOgTarget } from "@okouai/api-contracts/contracts/artifact-og";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { hostedDeployments, hostedSites } from "@okouai/db/runtime/hosted-site";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { env } from "../../lib/env";
import { hostedLinkDomain } from "../../lib/link-layout";
import { db$ } from "../external/db";
import {
  unfurlSlackLinks,
  type SlackLinkUnfurl,
} from "../external/slack-message-client";
import { artifactDeliveryRecord } from "./artifact-delivery.service";
import { artifactOgMetadata$ } from "./artifact-og.service";
import {
  publicArtifactShareIdentity$,
  resolvePublicArtifactSource$,
} from "./artifact-shares.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

export const slackLinkSharedEventSchema = z.object({
  type: z.literal("link_shared"),
  channel: z.string().min(1),
  message_ts: z.string().min(1),
  links: z.array(z.object({ url: z.string().min(1) })),
});

export type SlackLinkSharedEvent = z.infer<typeof slackLinkSharedEventSchema>;

function escapeSlackLinkText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseSlackLinkUrl(value: string): URL | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) &&
    !url.username &&
    !url.password
    ? url
    : null;
}

function hostedArtifactAlias(url: URL): string | null {
  const suffix = `.${hostedLinkDomain("current")}`;
  if (
    url.port ||
    !url.hostname.endsWith(suffix) ||
    (url.pathname !== "/" && url.pathname !== "/index.html")
  ) {
    return null;
  }
  const alias = url.hostname.slice(0, -suffix.length);
  return alias && !alias.includes(".") ? alias : null;
}

function slackUnfurlInstallation(workspaceId: string) {
  return computed(async (get) => {
    const [installation] = await get(db$)
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
      .limit(1);
    return installation ?? null;
  });
}

function hostedDeploymentId(alias: string) {
  return computed(async (get) => {
    const id = alias.startsWith("dpl-")
      ? z.uuid().safeParse(alias.slice(4))
      : null;
    if (id && !id.success) {
      return null;
    }
    const [row] = await get(db$)
      .select({ id: hostedDeployments.id })
      .from(hostedDeployments)
      .innerJoin(hostedSites, eq(hostedSites.id, hostedDeployments.siteId))
      .where(
        and(
          eq(hostedSites.linkLayoutSegment, "okou"),
          eq(hostedDeployments.linkLayoutSegment, "okou"),
          eq(hostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
          id?.success
            ? eq(hostedDeployments.id, id.data)
            : and(
                eq(hostedSites.publicSlug, alias),
                eq(hostedSites.activeDeploymentId, hostedDeployments.id),
              ),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  });
}

const slackPublicationTarget$ = command(
  async (
    { set },
    record: Extract<ArtifactDeliveryRecord, { kind: "publication" }>,
    hostname: string,
    signal: AbortSignal,
  ): Promise<ArtifactOgTarget | null> => {
    const lookup = { kind: "share" as const, id: record.shareId };
    const owner = await set(publicArtifactShareIdentity$, lookup, signal);
    signal.throwIfAborted();
    if (!owner) {
      return null;
    }
    const published = await set(
      resolvePublicArtifactSource$,
      lookup,
      owner,
      signal,
    );
    signal.throwIfAborted();
    // The live policy must still publish this exact alias, not just its owner.
    return published &&
      published.policy.publicToken === record.publicToken &&
      published.policy.publicBrand === record.publicBrand &&
      published.policy.target.kind === "html" &&
      new URL(published.url).hostname === hostname
      ? { kind: "reference", id: record.shareId.replaceAll("-", "") }
      : null;
  },
);

/** Resolve only known delivery identities; never fetch a user-supplied URL. */
const slackArtifactOgTarget$ = command(
  async (
    { get, set },
    value: string,
    signal: AbortSignal,
  ): Promise<ArtifactOgTarget | null> => {
    const url = parseSlackLinkUrl(value);
    if (!url) {
      return null;
    }
    if (url.origin === new URL(env("APP_URL")).origin) {
      const reference = parseArtifactReference(url.pathname);
      return reference
        ? { kind: "reference", id: `${reference.hash}${reference.extension}` }
        : null;
    }
    const alias = hostedArtifactAlias(url);
    if (!alias) {
      return null;
    }
    const record = await get(
      artifactDeliveryRecord("current", "html", alias, signal),
    );
    signal.throwIfAborted();
    if (record?.kind === "publication" && record.targetKind === "html") {
      return await set(slackPublicationTarget$, record, url.hostname, signal);
    }
    if (record?.kind === "thread-resource") {
      return record.targetKind === "html" && record.targetId
        ? {
            kind: "thread",
            id: record.threadId,
            targetId: record.targetId,
            token: record.publicToken,
            publicBrand: record.publicBrand,
          }
        : null;
    }
    if (record?.kind !== "legacy-site") {
      return null;
    }
    // Public hosted sites use the registry's legacy-site discriminator.
    const id = await get(hostedDeploymentId(alias));
    signal.throwIfAborted();
    return id ? { kind: "host", id } : null;
  },
);

const slackArtifactUnfurl$ = command(
  async (
    { set },
    url: string,
    signal: AbortSignal,
  ): Promise<SlackLinkUnfurl | null> => {
    const target = await set(slackArtifactOgTarget$, url, signal);
    if (!target) {
      return null;
    }
    // This is the same anonymous publication policy used by the OG endpoints.
    const metadata = await set(artifactOgMetadata$, target, signal);
    signal.throwIfAborted();
    if (!metadata.available) {
      return null;
    }
    const title = metadata.title.trim().slice(0, 150) || "Okou artifact";
    const pageUrl = new URL(url);
    // A pipe in the URL must not become Slack's link-label separator.
    const href = escapeSlackLinkText(pageUrl.href.replaceAll("|", "%7C"));
    return {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${pageUrl.hostname}*\n*<${href}|${escapeSlackLinkText(title)}>*`,
            verbatim: true,
          },
        },
        ...(metadata.description
          ? [
              {
                type: "section" as const,
                text: {
                  type: "plain_text" as const,
                  text: metadata.description.slice(0, 3000),
                },
              },
            ]
          : []),
        {
          type: "context",
          elements: [{ type: "plain_text", text: pageUrl.hostname }],
        },
        { type: "image", image_url: metadata.imageUrl, alt_text: title },
      ],
    };
  },
);

export const unfurlSlackArtifactLinks$ = command(
  async (
    { get, set },
    args: {
      readonly workspaceId: string;
      readonly event: SlackLinkSharedEvent;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const installation = await get(slackUnfurlInstallation(args.workspaceId));
    signal.throwIfAborted();
    if (!installation?.orgId || !installation.botScopes) {
      return;
    }
    const scopes = z
      .array(z.string())
      .parse(JSON.parse(installation.botScopes));
    if (!scopes.includes("links:read") || !scopes.includes("links:write")) {
      return;
    }
    const featureContext = installation.installedByUserId
      ? await set(
          loadUserFeatureSwitchContext$,
          installation.orgId,
          installation.installedByUserId,
          signal,
        )
      : { orgId: installation.orgId };
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.SlackLinkUnfurls, featureContext)) {
      return;
    }
    const unfurls: Record<string, SlackLinkUnfurl> = {};
    const urls = new Set(
      args.event.links.map((link) => {
        return link.url;
      }),
    );
    for (const url of urls) {
      const preview = await set(slackArtifactUnfurl$, url, signal);
      signal.throwIfAborted();
      if (preview) {
        // Slack requires the exact shared URL, including its query and fragment.
        unfurls[url] = preview;
      }
    }
    if (Object.keys(unfurls).length === 0) {
      return;
    }
    const token = await decryptPersistentSecretValue(
      installation.encryptedBotToken,
      featureContext,
    );
    signal.throwIfAborted();
    await unfurlSlackLinks(
      token,
      {
        channel: args.event.channel,
        // thread_ts identifies the parent, not the message containing the link.
        ts: args.event.message_ts,
        unfurls,
      },
      signal,
    );
  },
);
