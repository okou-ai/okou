import { command, computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { escapeText } from "entities/escape";
import { z } from "zod";
import type { ArtifactDeliveryRecord } from "@okouai/api-contracts/contracts/artifact-delivery";
import type { ArtifactOgTarget } from "@okouai/api-contracts/contracts/artifact-og";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { ARTIFACT_OG_BRAND } from "@okouai/core/artifact-og";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import { hostedDeployments, hostedSites } from "@okouai/db/runtime/hosted-site";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { env } from "../../lib/env";
import { hostedLinkDomain } from "../../lib/link-layout";
import { SLACK_PREVIEW_IMAGE_HEIGHT } from "../../lib/slack-preview-image";
import { db$ } from "../external/db";
import {
  unfurlSlackLinks,
  type SlackLinkUnfurl,
} from "../external/slack-message-client";
import { fetchSlackPageMetadata } from "../external/slack-page-metadata";
import { artifactDeliveryRecord } from "./artifact-delivery.service";
import { artifactOgMetadata$ } from "./artifact-og.service";
import {
  publicArtifactShareIdentity$,
  resolvePublicArtifactSource$,
} from "./artifact-shares.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { slackPreviewImageUrl } from "./slack-preview-image.service";

export const slackLinkSharedEventSchema = z.object({
  type: z.literal("link_shared"),
  channel: z.string().min(1),
  message_ts: z.string().min(1),
  links: z.array(z.object({ url: z.string().min(1) })),
});

export type SlackLinkSharedEvent = z.infer<typeof slackLinkSharedEventSchema>;

function escapeSlackLinkText(value: string): string {
  // Slack decodes only amp/lt/gt; retain non-breaking spaces as Unicode.
  return escapeText(value).replaceAll("&nbsp;", "\u00a0");
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
  if (url.port || !url.hostname.endsWith(suffix)) {
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

/** Resolve artifact identities from validated links without fetching URLs. */
const slackArtifactOgTarget$ = command(
  async (
    { get, set },
    url: URL,
    signal: AbortSignal,
  ): Promise<ArtifactOgTarget | null> => {
    if (url.origin === new URL(env("APP_URL")).origin) {
      const reference = parseArtifactReference(url.pathname);
      return reference
        ? { kind: "reference", id: `${reference.hash}${reference.extension}` }
        : null;
    }
    const alias = hostedArtifactAlias(url);
    if (!alias || (url.pathname !== "/" && url.pathname !== "/index.html")) {
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

interface SlackPageMetadata {
  readonly title: string;
  readonly imageUrl: string | null;
  readonly description?: string;
}

const defaultSlackMetadata$ = command(
  async (
    { set },
    url: URL,
    signal: AbortSignal,
  ): Promise<SlackPageMetadata | null> => {
    const target = await set(slackArtifactOgTarget$, url, signal);
    if (!target && url.origin !== new URL(env("APP_URL")).origin) {
      return null;
    }
    const metadata = target
      ? await set(artifactOgMetadata$, target, "slack", signal)
      : { available: true as const, ...ARTIFACT_OG_BRAND };
    signal.throwIfAborted();
    if (!metadata.available) {
      return null;
    }
    const imageUrl = new URL(
      target
        ? metadata.imageUrl
        : r2ImageTransformUrl(metadata.imageUrl, {
            height: SLACK_PREVIEW_IMAGE_HEIGHT,
          }),
    );
    return { title: metadata.title, imageUrl: imageUrl.href };
  },
);

const publicSlackMetadata$ = command(
  async (
    { set },
    url: URL,
    signal: AbortSignal,
  ): Promise<SlackPageMetadata | null> => {
    // Only supported origins may supply anonymous page metadata.
    const isAppUrl = url.origin === new URL(env("APP_URL")).origin;
    if (!isAppUrl && !hostedArtifactAlias(url)) {
      return null;
    }
    // Preserve artifact publication checks and metadata. A private artifact's
    // App shell can still contain branding, which is not permission to unfurl.
    const isArtifactUrl = isAppUrl
      ? parseArtifactReference(url.pathname) !== null
      : url.pathname === "/" || url.pathname === "/index.html";
    if (isArtifactUrl) {
      return await set(defaultSlackMetadata$, url, signal);
    }
    const page = await fetchSlackPageMetadata(url, signal);
    if (!page) {
      return null;
    }
    if (page.title || page.description || page.imageUrl) {
      return {
        title: page.title ?? ARTIFACT_OG_BRAND.title,
        imageUrl: slackPreviewImageUrl(
          page.imageUrl ?? ARTIFACT_OG_BRAND.imageUrl,
        ),
        description: page.description,
      };
    }
    return await set(defaultSlackMetadata$, url, signal);
  },
);

const slackArtifactUnfurl$ = command(
  async (
    { set },
    url: string,
    signal: AbortSignal,
  ): Promise<SlackLinkUnfurl | null> => {
    const pageUrl = parseSlackLinkUrl(url);
    if (!pageUrl) {
      return null;
    }
    const metadata = await set(publicSlackMetadata$, pageUrl, signal);
    signal.throwIfAborted();
    if (!metadata) {
      return null;
    }
    const title = metadata.title.trim().slice(0, 150) || "Okou artifact";
    // A pipe in the URL must not become Slack's link-label separator.
    const href = escapeSlackLinkText(pageUrl.href.replaceAll("|", "%7C"));
    const imageUrl =
      metadata.imageUrl && metadata.imageUrl.length <= 3000
        ? metadata.imageUrl
        : null;
    return {
      blocks: [
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*<${href}|${escapeSlackLinkText(title)}>*`,
            verbatim: true,
          },
        },
        ...(metadata.description
          ? [
              {
                type: "section" as const,
                text: {
                  type: "plain_text" as const,
                  text: metadata.description,
                  emoji: false,
                },
              },
            ]
          : []),
        ...(imageUrl
          ? [{ type: "image" as const, image_url: imageUrl, alt_text: title }]
          : []),
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
      {
        orgId: installation.orgId,
        userId: installation.installedByUserId ?? undefined,
      },
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
