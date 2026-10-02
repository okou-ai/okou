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
import { safeSqlStateCode } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";
import { settle, safeSync } from "../utils";
import { parseVncClientIdentity } from "./vnc-client-identity.service";
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
import type { VncOwner } from "./vnc-owner-lifecycle.service";

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
    row.authMethod === "qemu_scram_sha256" ||
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

export function validVncClientAuthentication(
  authentication: VncAuthentication,
): boolean {
  if (
    authentication.method !== "client_certificate" &&
    authentication.method !== "client_certificate_vnc_password"
  ) {
    return true;
  }
  const result = safeSync(() => {
    return parseVncClientIdentity(
      authentication.certificateChain,
      authentication.privateKey,
    );
  });
  return "ok" in result;
}

async function encryptAuthentication(
  authentication: VncAuthentication,
  featureContext: FeatureSwitchContext,
) {
  const identity =
    authentication.method === "client_certificate" ||
    authentication.method === "client_certificate_vnc_password"
      ? parseVncClientIdentity(
          authentication.certificateChain,
          authentication.privateKey,
        )
      : null;
  return {
    authMethod: authentication.method,
    username:
      authentication.method === "username_password" ||
      authentication.method === "qemu_scram_sha256" ||
      authentication.method === "apple_dh_username_password" ||
      authentication.method === "apple_srp_username_password" ||
      authentication.method === "apple_rsa_srp_username_password"
        ? authentication.username
        : null,
    encryptedPassword:
      authentication.method === "client_certificate"
        ? null
        : await encryptStoredSecretValue(
            authentication.password,
            featureContext,
          ),
    encryptedClientIdentity:
      identity === null
        ? null
        : await encryptStoredSecretValue(
            JSON.stringify(identity),
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

function isCredentialReferenceViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { cause } = error;
  const code = safeSqlStateCode(error);
  return (
    (code === "23503" || code === "23001") &&
    typeof cause === "object" &&
    cause !== null &&
    "constraint" in cause &&
    (cause.constraint === "vnc_connections_credential_owner_fk" ||
      cause.constraint === "vnc_connections_credential_profile_fk")
  );
}

export const createVncCredential$ = command(
  async (
    { set },
    args: {
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
    if (!validVncClientAuthentication(args.body.authentication)) {
      return vncFailure("invalidClientIdentity");
    }
    const prepared = await prepareCredential(args.body, args.featureContext);
    signal.throwIfAborted();
    const inserted = await settle(
      db
        .insert(vncCredentials)
        .values({ ...args.owner, ...prepared, id: args.id })
        .returning(vncCredentialMetadata),
      signal,
    );
    if (!inserted.ok) {
      return set(
        resolveVncCreationConflict$,
        {
          owner: args.owner,
          resource: "credential",
          id: args.id,
          error: inserted.error,
        },
        signal,
      );
    }
    const [created] = inserted.value;
    if (!created) {
      throw new Error("VNC credential insert returned no row");
    }
    return { ok: true, value: response(created, []) };
  },
);

function rejectCredentialUpdate(
  expectedRevision: number,
  authMethod: VncAuthentication["method"] | undefined,
  hosts: readonly {
    readonly generation: number;
    readonly securityType: typeof vncConnections.$inferSelect.securityType;
  }[],
): "profileMismatch" | "exhausted" | undefined {
  if (
    authMethod !== undefined &&
    hosts.some((host) => {
      return !isVncProfileCompatible(authMethod, host.securityType);
    })
  ) {
    return "profileMismatch";
  }
  if (
    expectedRevision === 2_147_483_647 ||
    (authMethod !== undefined &&
      hosts.some((host) => {
        return host.generation === 2_147_483_647;
      }))
  ) {
    return "exhausted";
  }
  return undefined;
}

export const updateVncCredential$ = command(
  async (
    { set },
    args: {
      readonly owner: VncOwner;
      readonly credentialId: string;
      readonly body: UpdateVncCredentialRequest;
      readonly featureContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<VncResult<VncCredentialResponse>> => {
    const db = set(writeDb$);
    const owner = args.owner;
    const [initial] = await db
      .select(vncCredentialMetadata)
      .from(vncCredentials)
      .where(ownedCredential(owner, args.credentialId));
    signal.throwIfAborted();
    if (!initial) {
      return vncFailure("credentialNotFound");
    }
    if (initial.revision !== args.body.expectedRevision) {
      return vncFailure("credentialConflict");
    }
    if (
      args.body.authentication &&
      !validVncClientAuthentication(args.body.authentication)
    ) {
      return vncFailure("invalidClientIdentity");
    }
    const hosts = await db
      .select({
        id: vncConnections.id,
        displayName: vncConnections.displayName,
        generation: vncConnections.generation,
        securityType: vncConnections.securityType,
      })
      .from(vncConnections)
      .where(referencingConnections(owner, args.credentialId))
      .orderBy(asc(vncConnections.id));
    signal.throwIfAborted();
    const rejected = rejectCredentialUpdate(
      initial.revision,
      args.body.authentication?.method,
      hosts,
    );
    if (rejected) {
      return vncFailure(rejected);
    }
    const encrypted =
      args.body.authentication === undefined
        ? undefined
        : await encryptAuthentication(
            args.body.authentication,
            args.featureContext,
          );
    signal.throwIfAborted();
    // The profile FK pins each bound host to its credential's auth method.
    const written = await settle(
      db.transaction(async (tx) => {
        if (encrypted !== undefined && hosts.length > 0) {
          await tx
            .update(vncConnections)
            .set({
              generation: sql`${vncConnections.generation} + 1`,
              updatedAt: nowDate(),
            })
            .where(referencingConnections(owner, args.credentialId));
        }
        const [row] = await tx
          .update(vncCredentials)
          .set({
            name: args.body.name,
            ...encrypted,
            revision: sql`${vncCredentials.revision} + 1`,
            updatedAt: nowDate(),
          })
          .where(ownedCredential(owner, args.credentialId))
          .returning(vncCredentialMetadata);
        return row;
      }),
      signal,
    );
    if (!written.ok) {
      if (isCredentialReferenceViolation(written.error)) {
        return vncFailure("profileMismatch");
      }
      throw written.error;
    }
    if (!written.value) {
      return vncFailure("credentialNotFound");
    }
    return {
      ok: true,
      value: response(
        written.value,
        hosts.map(({ id, displayName }) => {
          return { id, displayName };
        }),
      ),
    };
  },
);

export const deleteVncCredential$ = command(
  async (
    { set },
    args: {
      readonly owner: VncOwner;
      readonly credentialId: string;
      readonly expectedRevision: number;
    },
    signal: AbortSignal,
  ): Promise<VncResult<undefined>> => {
    const db = set(writeDb$);
    const [current] = await db
      .select({ revision: vncCredentials.revision })
      .from(vncCredentials)
      .where(ownedCredential(args.owner, args.credentialId));
    signal.throwIfAborted();
    if (!current) {
      return vncFailure("credentialNotFound");
    }
    if (current.revision !== args.expectedRevision) {
      return vncFailure("credentialConflict");
    }
    // The RESTRICT credential FK rejects deleting a credential used by a host.
    const deleted = await settle(
      db
        .delete(vncCredentials)
        .where(ownedCredential(args.owner, args.credentialId)),
      signal,
    );
    if (!deleted.ok) {
      if (isCredentialReferenceViolation(deleted.error)) {
        return vncFailure("credentialInUse");
      }
      throw deleted.error;
    }
    return { ok: true, value: undefined };
  },
);
