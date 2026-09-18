/**
 * The bounded, credential-free evidence that one source was authorized.
 *
 * A collection deadline does not make old authority valid forever. Result
 * acceptance, persisted-result readback, a new Chat commit and a new email
 * admission each happen later than the read, so each of them has to be able to
 * ask the one shared authorizer whether *this exact input* is still allowed.
 * What is retained for that question is a descriptor: enough to identify the
 * input, never enough to fetch it again.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import { createHash } from "node:crypto";

import type { MorningBriefSourceAuthorityProof } from "./morning-brief-connector-reader.service";
import type { MorningBriefSourceKind } from "./morning-brief-source-item";

export type { MorningBriefSourceAuthorityProof };

/** At most one descriptor per source. */
export const MORNING_BRIEF_MAX_RETAINED_DESCRIPTORS = 5;

/** The serialized ceiling for one descriptor. */
export const MORNING_BRIEF_DESCRIPTOR_MAX_BYTES = 2048;

/** The serialized ceiling for the whole retained set. */
export const MORNING_BRIEF_DESCRIPTOR_SET_MAX_BYTES = 8192;

/** A provider account reference is an identity, never a token. */
export const MORNING_BRIEF_ACCOUNT_REF_MAX_BYTES = 128;

/**
 * How many contributing containers one descriptor names.
 *
 * Enough to revalidate the real scope of a bounded collection, few enough that
 * the retained set stays metadata. A collection that contributed from more
 * containers than this is rejected rather than silently trimmed, because a
 * descriptor that forgot a channel would make a later check pass by not asking
 * about it.
 */
const MORNING_BRIEF_MAX_DESCRIPTOR_CONTAINERS = 24;

/** S5 keeps accepted result content for 24 hours from reservation. */
export const MORNING_BRIEF_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** S2 gives an outbox request 15 minutes from the moment it was created. */
export const MORNING_BRIEF_OUTBOX_DEADLINE_MS = 15 * 60 * 1000;

/**
 * Evidence about one input, scoped to one owner and one occurrence.
 *
 * It is not a bearer capability and not a cached allow: every field exists so a
 * later check can be *re-run* against live state, and none of them can stand in
 * for that check's answer.
 */
export interface MorningBriefRetainedSourceDescriptor {
  readonly source: MorningBriefSourceKind;
  /** The exact selected connection; null for native Slack and for Chat. */
  readonly connectionId: string | null;
  /** The provider account identity actually read, never a credential. */
  readonly accountRef: string | null;
  /**
   * A digest of the authorization surface this read actually exercised.
   *
   * For a connector source it is the effective permissions the shared reader
   * admitted the read under; for the first-party sources it is the granted
   * surface they read through. Either way it is a digest, not the scopes: a
   * later narrowing is detectable without the descriptor describing what a
   * token can still do. It is never a digest of constant method names, which
   * would hash identically after a grant was withdrawn.
   */
  readonly scopeDigest: string;
  /**
   * The exact endpoints whose results this input still holds.
   *
   * One representative URL per distinct permission, which is precisely what the
   * shared reader's release fence already re-evaluates. Retaining them is what
   * lets a later phase repeat the *same* live check instead of asking a
   * narrower question; a digest alone cannot name what to re-ask.
   *
   * Empty for the first-party sources, which authorize against their own
   * containers rather than an HTTP policy.
   */
  readonly endpoints: readonly string[];
  readonly membershipId: string;
  readonly agentId: string;
  readonly capturedAt: string;
  /**
   * The provider containers this input actually came from.
   *
   * A digest of constant method names proves which API was called, not which
   * channels, threads or mailboxes the owner's evidence came from — so it
   * cannot tell a later check what to revalidate. These are the real container
   * ids that contributed, bounded so the retained set stays small: a check can
   * ask the shared reader whether *these* are still readable.
   */
  readonly containers: readonly string[];
  /**
   * True when this source's material entered the model input.
   *
   * Uncited input still counts. The model may have used a message without
   * citing it, so reducing the later permission checks to the output's citation
   * ids would check the wrong set.
   */
  readonly contributed: boolean;
}

/**
 * Digest the granted scope set so a later narrowing is detectable.
 *
 * Scopes are sorted and deduplicated first, because the provider's ordering is
 * not stable and an unchanged grant must not look like a changed one.
 */
export function morningBriefScopeDigest(scopes: readonly string[]): string {
  const canonical = [...new Set(scopes)].sort().join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The connection, authorization surface and endpoints a real read proved.
 *
 * An absent proof means no authorized read released anything for this source,
 * which is recorded as exactly that. The empty digest is deliberate: a digest
 * over an empty scope list is still a valid-looking hash, and a descriptor that
 * looks proven without a proof is the failure this whole module exists to
 * prevent.
 */
export function morningBriefProvenAuthority(
  proof: MorningBriefSourceAuthorityProof | null,
): {
  readonly connectionId: string | null;
  readonly scopeDigest: string;
  readonly endpoints: readonly string[];
} {
  if (proof === null) {
    return { connectionId: null, scopeDigest: "", endpoints: [] };
  }
  return {
    connectionId: proof.connectionId,
    // The permissions this read was actually admitted under, so a later
    // narrowing is detectable. Constant method names describe an API, not an
    // authority, and would digest identically after a grant was withdrawn.
    scopeDigest: morningBriefScopeDigest(proof.permissions),
    endpoints: proof.endpoints,
  };
}

function descriptorBytes(
  descriptor: MorningBriefRetainedSourceDescriptor,
): number {
  return Buffer.byteLength(JSON.stringify(descriptor), "utf8");
}

type MorningBriefDescriptorSetError =
  | "duplicate-source"
  | "too-many-sources"
  | "descriptor-too-large"
  | "set-too-large"
  | "account-ref-too-large"
  | "too-many-containers"
  | "too-many-endpoints"
  | "unproven-authority";

/**
 * How many endpoints one descriptor names.
 *
 * The reader keeps one representative URL per distinct permission and the
 * accepted catalog gives a source a small, fixed permission set, so this bounds
 * a real quantity rather than an arbitrary one.
 */
const MORNING_BRIEF_MAX_DESCRIPTOR_ENDPOINTS = 8;

/** Whether this source's authority is an OAuth connection the owner selected. */
function isConnectorBackedSource(source: MorningBriefSourceKind): boolean {
  return source === "gmail" || source === "calendar" || source === "github";
}

/**
 * Whether this descriptor can actually carry a later permission check.
 *
 * Only material that entered the model input has to be re-askable, so a source
 * that supplied nothing is not held to it. For one that did, a null connection,
 * an unproven account or no retained endpoint would make every later check pass
 * by having nothing to ask about — while the evidence it was meant to cover
 * went out anyway. Chat and native Slack carry no connector row, so their proof
 * is the owner-scoped identity and the containers they actually read.
 */
function provesRetainedAuthority(
  descriptor: MorningBriefRetainedSourceDescriptor,
): boolean {
  if (!descriptor.contributed) {
    return true;
  }
  if (descriptor.accountRef === null || descriptor.scopeDigest === "") {
    return false;
  }
  if (!isConnectorBackedSource(descriptor.source)) {
    return descriptor.containers.length > 0;
  }
  return descriptor.connectionId !== null && descriptor.endpoints.length > 0;
}

/**
 * Accept a retained set only when it fits every declared bound.
 *
 * Rejecting here rather than truncating is deliberate: a descriptor set that
 * silently lost a source would make the later checks pass by forgetting what
 * they were supposed to check.
 */
export function boundMorningBriefDescriptors(
  descriptors: readonly MorningBriefRetainedSourceDescriptor[],
):
  | {
      readonly kind: "bounded";
      readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
      readonly bytes: number;
    }
  | {
      readonly kind: "rejected";
      readonly reason: MorningBriefDescriptorSetError;
    } {
  if (descriptors.length > MORNING_BRIEF_MAX_RETAINED_DESCRIPTORS) {
    return { kind: "rejected", reason: "too-many-sources" };
  }
  const sources = new Set<MorningBriefSourceKind>();
  const bytes = Buffer.byteLength(JSON.stringify(descriptors), "utf8");
  if (bytes > MORNING_BRIEF_DESCRIPTOR_SET_MAX_BYTES) {
    return { kind: "rejected", reason: "set-too-large" };
  }
  for (const descriptor of descriptors) {
    if (sources.has(descriptor.source)) {
      return { kind: "rejected", reason: "duplicate-source" };
    }
    sources.add(descriptor.source);
    if (
      descriptor.containers.length > MORNING_BRIEF_MAX_DESCRIPTOR_CONTAINERS
    ) {
      return { kind: "rejected", reason: "too-many-containers" };
    }
    if (descriptor.endpoints.length > MORNING_BRIEF_MAX_DESCRIPTOR_ENDPOINTS) {
      return { kind: "rejected", reason: "too-many-endpoints" };
    }
    if (!provesRetainedAuthority(descriptor)) {
      return { kind: "rejected", reason: "unproven-authority" };
    }
    if (
      descriptor.accountRef !== null &&
      Buffer.byteLength(descriptor.accountRef, "utf8") >
        MORNING_BRIEF_ACCOUNT_REF_MAX_BYTES
    ) {
      return { kind: "rejected", reason: "account-ref-too-large" };
    }
    const size = descriptorBytes(descriptor);
    if (size > MORNING_BRIEF_DESCRIPTOR_MAX_BYTES) {
      return { kind: "rejected", reason: "descriptor-too-large" };
    }
  }
  return { kind: "bounded", descriptors, bytes };
}

/**
 * How long the credential-free descriptors must outlive the result body.
 *
 * The result's own 24 hours is not enough. A Chat commit made just before that
 * expiry can still create an email obligation, and that obligation keeps the
 * outbox deadline it was originally given — so the descriptors have to survive
 * until the later of the two, up to 24h15m from reservation.
 *
 * Neither deadline is reset here. `outboxCreatedAt` is the original creation
 * instant, not the latest retry, so a retry cannot extend the window, and the
 * extension carries metadata only: no result body and no source content is kept
 * with it.
 */
export function morningBriefDescriptorRetainUntil(
  reservedAt: Date,
  outboxCreatedAt: Date | null,
): Date {
  const resultExpiresAt =
    reservedAt.getTime() + MORNING_BRIEF_RESULT_RETENTION_MS;
  if (outboxCreatedAt === null) {
    return new Date(resultExpiresAt);
  }
  const outboxDeadline =
    outboxCreatedAt.getTime() + MORNING_BRIEF_OUTBOX_DEADLINE_MS;
  return new Date(Math.max(resultExpiresAt, outboxDeadline));
}

/**
 * Which retained sources a later phase must revalidate.
 *
 * Everything that entered the model input is returned, cited or not. A source
 * that supplied no content is not returned, because an unconfigured connector
 * is not a reason to withhold a brief built from the owner's other authorized
 * sources.
 */
export function morningBriefSourcesToRevalidate(
  descriptors: readonly MorningBriefRetainedSourceDescriptor[],
): readonly MorningBriefRetainedSourceDescriptor[] {
  return descriptors.filter((descriptor) => {
    return descriptor.contributed;
  });
}
