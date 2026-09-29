import type {
  CreateVncCredentialRequest,
  UpdateVncCredentialRequest,
  VncAuthentication,
  VncCredentialResponse,
  VncCredentialSelection,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, asc, eq, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { command } from "ccstate";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { encryptStoredSecretValue } from "./crypto.utils";
import {
  isVncProfileCompatible,
  vncFailure,
  type VncResult,
} from "./vnc-configuration.utils";
import {
  inspectVncCreationId$,
  resolveVncCreationConflict$,
} from "./vnc-creation.service";
import {
  vncMemberIdentityWhere,
  type VncOwner,
} from "./vnc-owner-lifecycle.service";

const vncCredentialMetadata = Object.freeze({
  id: vncCredentials.id,
  name: vncCredentials.name,
  username: vncCredentials.username,
  authMethod: vncCredentials.authMethod,
  revision: vncCredentials.revision,
  createdAt: vncCredentials.createdAt,
  updatedAt: vncCredentials.updatedAt,
});
type Metadata = Pick<
  typeof vncCredentials.$inferSelect,
  keyof typeof vncCredentialMetadata
>;

function ownedCredential(owner: VncOwner, id: string) {
  return and(
    eq(vncCredentials.id, id),
    eq(vncCredentials.orgId, owner.orgId),
    eq(vncCredentials.userId, owner.userId),
  );
}

function referencingConnections(owner: VncOwner, credentialId: string) {
  return and(
    eq(vncConnections.credentialId, credentialId),
    eq(vncConnections.orgId, owner.orgId),
    eq(vncConnections.userId, owner.userId),
  );
}

function response(
  row: Metadata,
  hosts: VncCredentialResponse["hosts"],
): VncCredentialResponse {
  const common = {
    id: row.id,
    name: row.name,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hosts,
  };
  if (
    row.authMethod === "username_password" ||
    row.authMethod === "apple_dh_username_password" ||
    row.authMethod === "apple_srp_username_password" ||
    row.authMethod === "apple_rsa_srp_username_password"
  ) {
    if (row.username === null) {
      throw new Error("VNC username/password credential is missing a username");
    }
    return { ...common, authMethod: row.authMethod, username: row.username };
  }
  if (row.username !== null) {
    throw new Error("VNC password credential has an unexpected username");
  }
  return { ...common, authMethod: row.authMethod };
}

export const listVncCredentials$ = command(
  async (
    { set },
    owner: VncOwner,
    signal: AbortSignal,
  ): Promise<VncCredentialResponse[]> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        credential: vncCredentialMetadata,
        host: {
          id: vncConnections.id,
          displayName: vncConnections.displayName,
        },
      })
      .from(vncCredentials)
      .leftJoin(
        vncConnections,
        and(
          eq(vncConnections.credentialId, vncCredentials.id),
          eq(vncConnections.orgId, vncCredentials.orgId),
          eq(vncConnections.userId, vncCredentials.userId),
        ),
      )
      .where(
        and(
          eq(vncCredentials.orgId, owner.orgId),
          eq(vncCredentials.userId, owner.userId),
        ),
      )
      .orderBy(
        asc(vncCredentials.createdAt),
        asc(vncCredentials.id),
        asc(vncConnections.id),
      );
    signal.throwIfAborted();
    const values = new Map<string, VncCredentialResponse>();
    for (const row of rows) {
      let value = values.get(row.credential.id);
      if (!value) {
        value = response(row.credential, []);
        values.set(value.id, value);
      }
      if (row.host) {
        value.hosts.push(row.host);
      }
    }
    return [...values.values()];
  },
);

async function encryptAuthentication(
  authentication: VncAuthentication,
  featureContext: FeatureSwitchContext,
) {
  return {
    authMethod: authentication.method,
    username:
      authentication.method === "username_password" ||
      authentication.method === "apple_dh_username_password" ||
      authentication.method === "apple_srp_username_password" ||
      authentication.method === "apple_rsa_srp_username_password"
        ? authentication.username
        : null,
    encryptedPassword: await encryptStoredSecretValue(
      authentication.password,
      featureContext,
    ),
  };
}

async function prepareCredential(
  body: CreateVncCredentialRequest,
  featureContext: FeatureSwitchContext,
) {
  return {
    name: body.name,
    ...(await encryptAuthentication(body.authentication, featureContext)),
  };
}

export async function prepareVncCredentialSelection(
  selection: VncCredentialSelection,
  featureContext: FeatureSwitchContext,
) {
  return "id" in selection
    ? { id: selection.id }
    : { create: await prepareCredential(selection.create, featureContext) };
}

export const createVncCredential$ = command(
  async (
    { set },
    args: {
      readonly memberCreatedAt: string;
      readonly owner: VncOwner;
      readonly body: CreateVncCredentialRequest;
      readonly id: string;
      readonly featureContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<VncResult<VncCredentialResponse | undefined>> => {
    const db = set(writeDb$);
    const preflight = await set(
      inspectVncCreationId$,
      args.owner,
      "credential",
      args.id,
      signal,
    );
    signal.throwIfAborted();
    if (!preflight.ok) {
      return preflight;
    }
    if (!preflight.value) {
      return { ok: true, value: undefined };
    }
    const prepared = await prepareCredential(args.body, args.featureContext);
    signal.throwIfAborted();
    const transaction = await settle(
      db.transaction(async (tx) => {
        const [member] = await tx
          .select({ userId: orgMembersMetadata.userId })
          .from(orgMembersMetadata)
          .where(vncMemberIdentityWhere(args))
          .for("update");
        if (!member) {
          return vncFailure("membershipRevoked");
        }
        signal.throwIfAborted();
        const owner = args.owner;
        const [existing] = await tx
          .select({
            orgId: vncCredentials.orgId,
            userId: vncCredentials.userId,
          })
          .from(vncCredentials)
          .where(eq(vncCredentials.id, args.id));
        if (existing) {
          return existing.orgId === owner.orgId &&
            existing.userId === owner.userId
            ? { ok: true as const, value: undefined }
            : vncFailure("resourceIdConflict");
        }
        const [created] = await tx
          .insert(vncCredentials)
          .values({ ...owner, ...prepared, id: args.id })
          .returning(vncCredentialMetadata);
        if (!created) {
          throw new Error("VNC credential insert returned no row");
        }
        return { ok: true as const, value: response(created, []) };
      }),
    );
    signal.throwIfAborted();
    if (!transaction.ok) {
      return set(
        resolveVncCreationConflict$,
        {
          owner: args.owner,
          resource: "credential",
          id: args.id,
          error: transaction.error,
        },
        signal,
      );
    }
    return transaction.value;
  },
);

export const updateVncCredential$ = command(
  async (
    { set },
    args: {
      readonly memberCreatedAt: string;
      readonly owner: VncOwner;
      readonly credentialId: string;
      readonly body: UpdateVncCredentialRequest;
      readonly featureContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<VncResult<VncCredentialResponse>> => {
    const db = set(writeDb$);
    const [initial] = await db
      .select(vncCredentialMetadata)
      .from(vncCredentials)
      .where(ownedCredential(args.owner, args.credentialId));
    signal.throwIfAborted();
    if (!initial) {
      return vncFailure("credentialNotFound");
    }
    if (initial.revision !== args.body.expectedRevision) {
      return vncFailure("credentialConflict");
    }
    const encrypted =
      args.body.authentication === undefined
        ? undefined
        : await encryptAuthentication(
            args.body.authentication,
            args.featureContext,
          );
    signal.throwIfAborted();
    return db.transaction(async (tx) => {
      const [member] = await tx
        .select({ userId: orgMembersMetadata.userId })
        .from(orgMembersMetadata)
        .where(vncMemberIdentityWhere(args))
        .for("update");
      if (!member) {
        return vncFailure("membershipRevoked");
      }
      signal.throwIfAborted();
      const owner = args.owner;
      // Connections precede credentials in the global row-lock order, including
      // rotation, owner cleanup, and the later runtime authority consumer.
      const hosts = await tx
        .select({
          id: vncConnections.id,
          displayName: vncConnections.displayName,
          generation: vncConnections.generation,
          securityType: vncConnections.securityType,
        })
        .from(vncConnections)
        .where(referencingConnections(owner, args.credentialId))
        .orderBy(asc(vncConnections.id))
        .for("update");
      const [current] = await tx
        .select(vncCredentialMetadata)
        .from(vncCredentials)
        .where(ownedCredential(owner, args.credentialId))
        .for("update");
      if (!current) {
        return vncFailure("credentialNotFound");
      }
      if (current.revision !== args.body.expectedRevision) {
        return vncFailure("credentialConflict");
      }
      if (
        encrypted !== undefined &&
        hosts.some((host) => {
          return !isVncProfileCompatible(
            encrypted.authMethod,
            host.securityType,
          );
        })
      ) {
        return vncFailure("profileMismatch");
      }
      if (
        current.revision === 2_147_483_647 ||
        (encrypted !== undefined &&
          hosts.some((host) => {
            return host.generation === 2_147_483_647;
          }))
      ) {
        return vncFailure("exhausted");
      }
      const [updated] = await tx
        .update(vncCredentials)
        .set({
          name: args.body.name,
          ...encrypted,
          revision: current.revision + 1,
          updatedAt: nowDate(),
        })
        .where(
          and(
            ownedCredential(owner, args.credentialId),
            eq(vncCredentials.revision, args.body.expectedRevision),
          ),
        )
        .returning(vncCredentialMetadata);
      if (!updated) {
        throw new Error("VNC credential update returned no row");
      }
      if (encrypted !== undefined && hosts.length > 0) {
        await tx
          .update(vncConnections)
          .set({
            generation: sql`${vncConnections.generation} + 1`,
            updatedAt: nowDate(),
          })
          .where(referencingConnections(owner, args.credentialId));
      }
      return {
        ok: true as const,
        value: response(
          updated,
          hosts.map(({ id, displayName }) => {
            return { id, displayName };
          }),
        ),
      };
    });
  },
);

export const deleteVncCredential$ = command(
  (
    { set },
    args: {
      readonly memberCreatedAt: string;
      readonly owner: VncOwner;
      readonly credentialId: string;
      readonly expectedRevision: number;
    },
    signal: AbortSignal,
  ): Promise<VncResult<undefined>> => {
    const db = set(writeDb$);
    return db.transaction(async (tx) => {
      const [member] = await tx
        .select({ userId: orgMembersMetadata.userId })
        .from(orgMembersMetadata)
        .where(vncMemberIdentityWhere(args))
        .for("update");
      if (!member) {
        return vncFailure("membershipRevoked");
      }
      signal.throwIfAborted();
      const owner = args.owner;
      const [current] = await tx
        .select(vncCredentialMetadata)
        .from(vncCredentials)
        .where(ownedCredential(owner, args.credentialId))
        .for("update");
      if (!current) {
        return vncFailure("credentialNotFound");
      }
      if (current.revision !== args.expectedRevision) {
        return vncFailure("credentialConflict");
      }
      const [host] = await tx
        .select({ id: vncConnections.id })
        .from(vncConnections)
        .where(referencingConnections(owner, args.credentialId))
        .limit(1);
      if (host) {
        return vncFailure("credentialInUse");
      }
      const [deleted] = await tx
        .delete(vncCredentials)
        .where(
          and(
            ownedCredential(owner, args.credentialId),
            eq(vncCredentials.revision, args.expectedRevision),
          ),
        )
        .returning({ id: vncCredentials.id });
      if (!deleted) {
        return vncFailure("credentialConflict");
      }
      return { ok: true as const, value: undefined };
    });
  },
);
