import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import type { ArtifactSharePolicy } from "@okouai/api-contracts/contracts/artifact-shares";
import { artifactFilenameExtension } from "@okouai/api-contracts/contracts/artifact-delivery";
import { hostedSites } from "@okouai/db/schema/hosted-site";
import { artifactHash } from "../../lib/file-url";
import { publicSlugCandidate } from "../../lib/hosted-site-slug";
import { db$ } from "../external/db";
import { settle } from "../utils";
import { allocateArtifactReference$ } from "./artifact-reference.service";
import {
  ArtifactDeliveryAliasConflict,
  registerArtifactDelivery$,
} from "./artifact-delivery.service";

const MAX_ALIAS_ATTEMPTS = 10;
const allocatePublicArtifactSlug$ = command(
  async ({ get, set }, policy: ArtifactSharePolicy, signal: AbortSignal) => {
    if (policy.target.kind !== "html" || !policy.publicToken) {
      throw new Error("A public site is required");
    }
    const target = policy.target;
    const base = target.manifest.publicSlug;
    // These labels belong to the Worker's credential/legacy readers.
    const reserved =
      /^(?:p[vs]-[a-f0-9]{48}|sh-[a-f0-9]{32}-[a-f0-9]{24})$/u.test(base);
    for (let attempt = 0; attempt < MAX_ALIAS_ATTEMPTS; attempt += 1) {
      const alias = publicSlugCandidate(
        base,
        policy.orgId,
        policy.publicToken,
        attempt + (reserved ? 1 : 0),
      );
      const [otherSite] = await get(db$)
        .select({ id: hostedSites.id })
        .from(hostedSites)
        .where(
          and(
            eq(hostedSites.publicSlug, alias),
            ne(hostedSites.id, target.siteId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (otherSite) {
        continue;
      }
      const registered = await settle(
        set(
          registerArtifactDelivery$,
          {
            alias,
            targetKind: "html",
            record: {
              version: 1,
              kind: "publication",
              publicBrand: policy.publicBrand,
              shareId: policy.shareId,
              publicToken: policy.publicToken,
              targetKind: "html",
            },
          },
          signal,
        ),
        signal,
      );
      if (registered.ok) {
        return alias;
      }
      if (!(registered.error instanceof ArtifactDeliveryAliasConflict)) {
        throw registered.error;
      }
    }
    throw new Error("Unable to allocate a unique public artifact site name");
  },
);

const registerPublicArtifactFile$ = command(
  async (
    { set },
    args: { policy: ArtifactSharePolicy; preserveToken: boolean },
    signal: AbortSignal,
  ): Promise<string> => {
    const { policy } = args;
    if (policy.target.kind !== "file" || !policy.publicToken) {
      throw new Error("A public file is required");
    }
    for (let attempt = 0; attempt < MAX_ALIAS_ATTEMPTS; attempt += 1) {
      const token =
        attempt === 0 ? policy.publicToken : artifactHash(randomUUID());
      const registered = await settle(
        set(
          registerArtifactDelivery$,
          {
            alias: `${token}${artifactFilenameExtension(policy.target.filename)}`,
            targetKind: "file",
            record: {
              version: 1,
              kind: "publication",
              publicBrand: policy.publicBrand,
              shareId: policy.shareId,
              publicToken: token,
              targetKind: "file",
            },
          },
          signal,
        ),
        signal,
      );
      if (registered.ok) {
        return token;
      }
      if (
        args.preserveToken ||
        !(registered.error instanceof ArtifactDeliveryAliasConflict)
      ) {
        throw registered.error;
      }
    }
    throw new Error("Unable to allocate a unique public artifact file name");
  },
);

export const prepareArtifactShareAliases$ = command(
  async (
    { set },
    args: {
      readonly policy: ArtifactSharePolicy;
      readonly previous: ArtifactSharePolicy | undefined;
    },
    signal: AbortSignal,
  ): Promise<ArtifactSharePolicy> => {
    let organizationReference = args.previous?.organizationReference;
    if (args.policy.audience === "organization") {
      organizationReference = await set(
        allocateArtifactReference$,
        { kind: args.policy.target.kind, id: args.policy.target.id },
        signal,
      );
    }
    const next: ArtifactSharePolicy = {
      ...args.policy,
      ...(organizationReference ? { organizationReference } : {}),
    };
    if (!next.publicToken) {
      return next;
    }
    if (next.target.kind === "file") {
      next.publicToken = await set(
        registerPublicArtifactFile$,
        {
          policy: next,
          preserveToken: args.previous?.publicToken === next.publicToken,
        },
        signal,
      );
      return next;
    }
    if (
      args.previous?.publicToken === next.publicToken &&
      args.previous.publicSlug
    ) {
      next.publicSlug = args.previous.publicSlug;
    }
    // Preserve the requested durable token links as names are introduced.
    // #32492 owns retirement after accounting for old links and Worker readers;
    // revocation continues to invalidate both names through the same token.
    await set(
      registerArtifactDelivery$,
      {
        alias: next.publicToken,
        targetKind: next.target.kind,
        record: {
          version: 1,
          kind: "publication",
          publicBrand: next.publicBrand,
          shareId: next.shareId,
          publicToken: next.publicToken,
          targetKind: next.target.kind,
        },
      },
      signal,
    );
    if (next.target.kind === "html" && !next.publicSlug) {
      next.publicSlug = await set(allocatePublicArtifactSlug$, next, signal);
    }
    return next;
  },
);
