import { command } from "ccstate";
import type { ArtifactShareAccount } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactShareEmailSchema } from "@okouai/api-contracts/validators/artifact-access";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import type { ChannelSharingResource } from "./artifact-channel-resource.service";

export interface ArtifactChannelRecipient {
  readonly memberId: string;
  readonly email: string;
  readonly recipient: ArtifactShareAccount | undefined;
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
  recipient?: ArtifactShareAccount,
): ChannelMemberAccess {
  const email = artifactShareEmailSchema.safeParse(
    recipient?.email ?? input.email,
  );
  if (!email.success) {
    return { kind: "unknown", memberId: input.memberId };
  }
  const existing = input.resource.shares.find((share) => {
    return share.email === email.data;
  });
  if (existing) {
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

const workspaceEmailAccount$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly email: string | undefined },
    signal: AbortSignal,
  ): Promise<ArtifactShareAccount | null> => {
    const email = artifactShareEmailSchema.safeParse(args.email);
    if (!email.success) {
      return null;
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
      return null;
    }
    const user = await findClerkUser(get(clerk$), memberId, signal);
    if (
      !user ||
      user.banned ||
      !user.emailAddresses.some((address) => {
        return (
          address.verification?.status === "verified" &&
          address.emailAddress.trim().toLowerCase() === email.data
        );
      })
    ) {
      return null;
    }
    return {
      userId: user.id,
      email: email.data,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
    };
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
    const workspaceAccount = await set(
      workspaceEmailAccount$,
      { orgId: args.resource.orgId, email: args.email },
      signal,
    );
    if (workspaceAccount) {
      if (workspaceAccount.userId === args.resource.userId) {
        return { kind: "covered" };
      }
      if (args.resource.audience === "organization") {
        return { kind: "covered" };
      }
      return channelInvitation(args, workspaceAccount);
    }
    return channelInvitation(args);
  },
);
