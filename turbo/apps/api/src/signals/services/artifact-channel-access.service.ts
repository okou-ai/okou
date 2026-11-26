import { command } from "ccstate";
import type { HostedSiteShareAccount } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import { hostedSiteShareEmailSchema } from "@okouai/api-contracts/validators/hosted-site-sharing";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import type { ChannelSharingResource } from "./artifact-channel-resource.service";

export interface ArtifactChannelRecipient {
  readonly memberId: string;
  readonly email: string;
  readonly recipient: HostedSiteShareAccount | undefined;
}

export type ChannelMemberAccess =
  | { readonly kind: "covered" }
  | { readonly kind: "invited" }
  | { readonly kind: "unknown"; readonly memberId: string }
  | { readonly kind: "recipient"; readonly value: ArtifactChannelRecipient };

interface MemberInput {
  readonly resource: ChannelSharingResource;
  readonly memberId: string;
  readonly email: string | undefined;
}

function channelInvitation(
  input: MemberInput,
  recipient?: HostedSiteShareAccount,
): ChannelMemberAccess {
  const email = hostedSiteShareEmailSchema.safeParse(
    recipient?.email ?? input.email,
  );
  if (!email.success) {
    return { kind: "unknown", memberId: input.memberId };
  }
  const existing = input.resource.shares.find((share) => {
    return share.email === email.data;
  });
  if (existing) {
    // A claimed invitation cannot be reassigned using a recycled email.
    if (existing.userId === null) {
      return { kind: "invited" };
    }
    return existing.userId === recipient?.userId
      ? { kind: "covered" }
      : { kind: "unknown", memberId: input.memberId };
  }
  return {
    kind: "recipient",
    value: { memberId: input.memberId, email: email.data, recipient },
  };
}

const workspaceMemberAccess$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const members = await get(
      clerk$,
    ).organizations.getOrganizationMembershipList({
      organizationId: args.orgId,
      userId: [args.userId],
      limit: 1,
    });
    signal.throwIfAborted();
    return members.data.some((member) => {
      return (
        member.organization.id === args.orgId &&
        member.publicUserData?.userId === args.userId
      );
    });
  },
);

const workspaceEmailAccess$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly email: string | undefined },
    signal: AbortSignal,
  ) => {
    const email = hostedSiteShareEmailSchema.safeParse(args.email);
    if (!email.success) {
      return false;
    }
    const members = await get(
      clerk$,
    ).organizations.getOrganizationMembershipList({
      organizationId: args.orgId,
      emailAddress: [email.data],
      limit: 1,
    });
    signal.throwIfAborted();
    const memberId = members.data.find((member) => {
      return member.organization.id === args.orgId;
    })?.publicUserData?.userId;
    if (!memberId) {
      return false;
    }
    const user = await findClerkUser(get(clerk$), memberId, signal);
    return Boolean(
      user &&
      !user.banned &&
      user.emailAddresses.some((address) => {
        return (
          address.verification?.status === "verified" &&
          address.emailAddress.trim().toLowerCase() === email.data
        );
      }),
    );
  },
);

const linkedMemberAccess$ = command(
  async (
    { get, set },
    args: MemberInput & { readonly userId: string },
    signal: AbortSignal,
  ): Promise<ChannelMemberAccess> => {
    const user = await findClerkUser(get(clerk$), args.userId, signal);
    if (!user || user.banned) {
      return { kind: "unknown", memberId: args.memberId };
    }
    if (
      args.resource.shares.some((share) => {
        return share.userId === args.userId;
      })
    ) {
      return { kind: "covered" };
    }
    if (
      args.resource.audience === "organization" &&
      (await set(
        workspaceMemberAccess$,
        { orgId: args.resource.orgId, userId: args.userId },
        signal,
      ))
    ) {
      return { kind: "covered" };
    }
    const emails = user.emailAddresses
      .filter((email) => {
        return email.verification?.status === "verified";
      })
      .map((email) => {
        return email.emailAddress.trim().toLowerCase();
      });
    if (
      args.resource.shares.some((share) => {
        return share.userId === null && emails.includes(share.email);
      })
    ) {
      return { kind: "covered" };
    }
    const email = emails[0];
    if (!email) {
      return { kind: "unknown", memberId: args.memberId };
    }
    return channelInvitation(args, {
      userId: args.userId,
      email,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
    });
  },
);

export const artifactChannelMemberAccess$ = command(
  async (
    { set },
    args: MemberInput & { readonly userId: string | undefined },
    signal: AbortSignal,
  ): Promise<ChannelMemberAccess> => {
    if (args.userId === args.resource.userId) {
      return { kind: "covered" };
    }
    if (args.userId) {
      return set(linkedMemberAccess$, { ...args, userId: args.userId }, signal);
    }
    if (
      args.resource.audience === "organization" &&
      (await set(
        workspaceEmailAccess$,
        { orgId: args.resource.orgId, email: args.email },
        signal,
      ))
    ) {
      return { kind: "covered" };
    }
    return channelInvitation(args);
  },
);
