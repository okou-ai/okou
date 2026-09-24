import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import {
  renewErasureLease,
  type EncryptedErasureSelector,
  type ErasureHandler,
  type ErasureInventoryPage,
  type ErasureLease,
  type ErasureProof,
  type ErasureUnresolved,
} from "@okouai/db/operations/account-erasure";
import { connectors } from "@okouai/db/schema/connector";
import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { googleFormsWatchStates } from "@okouai/db/schema/google-forms-event";
import { googleWorkspaceEventSubscriptionStates } from "@okouai/db/schema/google-workspace-event";
import { secrets } from "@okouai/db/schema/secret";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { safeJsonParse } from "../utils";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";

const NAMESPACE = "c82377d6-ef22-4327-88b5-ac3e2059cff1";
const PAGE_SIZE = 100;
const cursorSchema = z.tuple([z.number().int().min(0).max(5), z.uuid()]);
export const CONNECTOR_REMOTE_ERASURE_COLLECTOR_VERSION =
  "038feb49-19ce-4ce9-a202-62dc73760c0d";

type ResourceType =
  | "connector"
  | "secret"
  | "gmail_watch"
  | "calendar_watch"
  | "forms_watch"
  | "meet_subscription";
type Resource = {
  readonly ordinal: number;
  readonly resourceType: ResourceType;
  readonly resourceId: string;
  readonly orgId: string;
  readonly connectorId: string | null;
  readonly locator: string | null;
  readonly credentialDigest: string | null;
  readonly credentialCiphertext?: string;
};
type Cursor = readonly [number, string];

function ref(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function unresolved(
  code: NonNullable<ErasureUnresolved["errorCode"]>,
): ErasureUnresolved {
  return {
    outcome: "capability_unresolved",
    errorCode: code,
    requestRef: null,
  };
}

async function selected(lease: ErasureLease) {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  return await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
}

async function readConnectorPage(
  db: Db,
  userId: string,
  after: Cursor | undefined,
  limit: number,
): Promise<Resource[]> {
  const rows: Resource[] = [];
  if (!after || after[0] === 0) {
    const accounts = await db
      .select({
        id: connectors.id,
        orgId: connectors.orgId,
        connectorSlug: connectors.connectorSlug,
        customConnectorId: connectors.customConnectorId,
        authMethod: connectors.authMethod,
        storageVersion: connectors.storageVersion,
        externalId: connectors.externalId,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.userId, userId),
          after ? gt(connectors.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(connectors.id))
      .limit(limit);
    rows.push(
      ...accounts.map((account) => {
        return {
          ordinal: 0,
          resourceType: "connector" as const,
          resourceId: account.id,
          orgId: account.orgId,
          connectorId: account.id,
          locator: JSON.stringify([
            account.connectorSlug,
            account.customConnectorId,
            account.authMethod,
            account.storageVersion,
            account.externalId,
          ]),
          credentialDigest: null,
        };
      }),
    );
  }
  return rows;
}

async function readSecretPage(
  db: Db,
  userId: string,
  after: Cursor | undefined,
  limit: number,
): Promise<Resource[]> {
  const rows: Resource[] = [];
  if (!after || after[0] <= 1) {
    const credentials = await db
      .select({
        id: secrets.id,
        orgId: secrets.orgId,
        connectorId: secrets.connectorId,
        name: secrets.name,
        encryptedValue: secrets.encryptedValue,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.userId, userId),
          eq(secrets.type, "connector"),
          after?.[0] === 1 ? gt(secrets.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(secrets.id))
      .limit(limit);
    rows.push(
      ...credentials.map((credential) => {
        return {
          ordinal: 1,
          resourceType: "secret" as const,
          resourceId: credential.id,
          orgId: credential.orgId,
          connectorId: credential.connectorId,
          locator: credential.name,
          // The B1 selector never contains access tokens or secret ciphertext.
          credentialDigest: createHash("sha256")
            .update(credential.encryptedValue)
            .digest("hex"),
          // Capture the already encrypted stored-secret envelope before its
          // catalog row is removed. The B1 selector encrypts it again at rest;
          // the digest alone cannot authorize a later provider revocation.
          credentialCiphertext: credential.encryptedValue,
        };
      }),
    );
  }
  return rows;
}

async function readGmailWatchPage(
  db: Db,
  userId: string,
  after: Cursor | undefined,
  limit: number,
): Promise<Resource[]> {
  const rows: Resource[] = [];
  if (!after || after[0] <= 2) {
    const watches = await db
      .select({
        id: gmailWatchStates.id,
        orgId: gmailWatchStates.orgId,
        connectorId: gmailWatchStates.connectorId,
        emailAddress: gmailWatchStates.emailAddress,
        topicName: gmailWatchStates.topicName,
      })
      .from(gmailWatchStates)
      .where(
        and(
          eq(gmailWatchStates.userId, userId),
          after?.[0] === 2 ? gt(gmailWatchStates.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(gmailWatchStates.id))
      .limit(limit);
    rows.push(
      ...watches.map((watch) => {
        return {
          ordinal: 2,
          resourceType: "gmail_watch" as const,
          resourceId: watch.id,
          orgId: watch.orgId,
          connectorId: watch.connectorId,
          locator: JSON.stringify([watch.emailAddress, watch.topicName]),
          credentialDigest: null,
        };
      }),
    );
  }
  return rows;
}

async function readCalendarWatchPage(
  db: Db,
  userId: string,
  after: Cursor | undefined,
  limit: number,
): Promise<Resource[]> {
  const rows: Resource[] = [];
  if (!after || after[0] <= 3) {
    const watches = await db
      .select({
        id: googleCalendarWatchStates.id,
        orgId: googleCalendarWatchStates.orgId,
        connectorId: googleCalendarWatchStates.connectorId,
        calendarId: googleCalendarWatchStates.calendarId,
        channelId: googleCalendarWatchStates.channelId,
        resourceId: googleCalendarWatchStates.resourceId,
        previousChannelId: googleCalendarWatchStates.previousChannelId,
        previousResourceId: googleCalendarWatchStates.previousResourceId,
      })
      .from(googleCalendarWatchStates)
      .where(
        and(
          eq(googleCalendarWatchStates.userId, userId),
          after?.[0] === 3
            ? gt(googleCalendarWatchStates.id, after[1])
            : undefined,
        ),
      )
      .orderBy(asc(googleCalendarWatchStates.id))
      .limit(limit);
    rows.push(
      ...watches.map((watch) => {
        return {
          ordinal: 3,
          resourceType: "calendar_watch" as const,
          resourceId: watch.id,
          orgId: watch.orgId,
          connectorId: watch.connectorId,
          locator: JSON.stringify([
            watch.calendarId,
            watch.channelId,
            watch.resourceId,
            watch.previousChannelId,
            watch.previousResourceId,
          ]),
          credentialDigest: null,
        };
      }),
    );
  }
  return rows;
}

async function readFormsWatchPage(
  db: Db,
  userId: string,
  after: Cursor | undefined,
  limit: number,
): Promise<Resource[]> {
  const rows: Resource[] = [];
  if (!after || after[0] <= 4) {
    const watches = await db
      .select({
        id: googleFormsWatchStates.id,
        orgId: googleFormsWatchStates.orgId,
        connectorId: googleFormsWatchStates.connectorId,
        formId: googleFormsWatchStates.formId,
        watchId: googleFormsWatchStates.watchId,
      })
      .from(googleFormsWatchStates)
      .where(
        and(
          eq(googleFormsWatchStates.userId, userId),
          after?.[0] === 4
            ? gt(googleFormsWatchStates.id, after[1])
            : undefined,
        ),
      )
      .orderBy(asc(googleFormsWatchStates.id))
      .limit(limit);
    rows.push(
      ...watches.map((watch) => {
        return {
          ordinal: 4,
          resourceType: "forms_watch" as const,
          resourceId: watch.id,
          orgId: watch.orgId,
          connectorId: watch.connectorId,
          locator: JSON.stringify([watch.formId, watch.watchId]),
          credentialDigest: null,
        };
      }),
    );
  }
  return rows;
}

async function readMeetSubscriptionPage(
  db: Db,
  userId: string,
  after: Cursor | undefined,
  limit: number,
): Promise<Resource[]> {
  const rows: Resource[] = [];
  if (!after || after[0] <= 5) {
    const subscriptions = await db
      .select({
        id: googleWorkspaceEventSubscriptionStates.id,
        orgId: googleWorkspaceEventSubscriptionStates.orgId,
        connectorId: googleWorkspaceEventSubscriptionStates.connectorId,
        subscriptionName:
          googleWorkspaceEventSubscriptionStates.subscriptionName,
      })
      .from(googleWorkspaceEventSubscriptionStates)
      .where(
        and(
          eq(googleWorkspaceEventSubscriptionStates.userId, userId),
          eq(googleWorkspaceEventSubscriptionStates.provider, "google-meet"),
          after?.[0] === 5
            ? gt(googleWorkspaceEventSubscriptionStates.id, after[1])
            : undefined,
        ),
      )
      .orderBy(asc(googleWorkspaceEventSubscriptionStates.id))
      .limit(limit);
    rows.push(
      ...subscriptions.map((subscription) => {
        return {
          ordinal: 5,
          resourceType: "meet_subscription" as const,
          resourceId: subscription.id,
          orgId: subscription.orgId,
          connectorId: subscription.connectorId,
          locator: subscription.subscriptionName,
          credentialDigest: null,
        };
      }),
    );
  }
  return rows;
}

async function readPage(
  db: Db,
  userId: string,
  after?: Cursor,
): Promise<Resource[]> {
  const rows: Resource[] = [];
  for (const read of [
    readConnectorPage,
    readSecretPage,
    readGmailWatchPage,
    readCalendarWatchPage,
    readFormsWatchPage,
    readMeetSubscriptionPage,
  ]) {
    if (rows.length === PAGE_SIZE) {
      break;
    }
    rows.push(...(await read(db, userId, after, PAGE_SIZE - rows.length)));
  }
  return rows;
}

async function inventory(
  db: Db,
  lease: ErasureLease,
  cursor: EncryptedErasureSelector | null,
): Promise<ErasureInventoryPage | ErasureUnresolved> {
  const subject = await selected(lease);
  if (subject?.kind !== "subject" || subject.subjectKind !== "user") {
    return unresolved("selector_missing");
  }
  await renewErasureLease(db, lease);
  let after: Cursor | undefined;
  if (cursor) {
    const decoded = await decryptErasureSelector(cursor);
    const parsed =
      decoded.kind === "cursor"
        ? cursorSchema.safeParse(safeJsonParse(decoded.after))
        : undefined;
    if (!parsed?.success) {
      return unresolved("selector_missing");
    }
    after = parsed.data;
  }
  const rows = await readPage(db, subject.subjectId, after);
  const connectorIds = [
    ...new Set(
      rows.flatMap((row) => {
        return row.connectorId === null ? [] : [row.connectorId];
      }),
    ),
  ];
  const owned =
    connectorIds.length === 0
      ? []
      : await db
          .select({ id: connectors.id, orgId: connectors.orgId })
          .from(connectors)
          .where(
            and(
              eq(connectors.userId, subject.subjectId),
              inArray(connectors.id, connectorIds),
            ),
          );
  const ownedOrgById = new Map(
    owned.map((account) => {
      return [account.id, account.orgId];
    }),
  );
  if (
    rows.some((row) => {
      return (
        row.connectorId === null ||
        ownedOrgById.get(row.connectorId) !== row.orgId
      );
    })
  ) {
    return unresolved("ownership_unknown");
  }
  const items = await Promise.all(
    rows.map(async (row) => {
      return {
        sinkId: lease.item.sinkId,
        itemKey: ref(["connector-remote", row.ordinal, row.resourceId]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "connector_remote",
          userId: subject.subjectId,
          orgId: row.orgId,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          connectorId: row.connectorId,
          locator: row.locator,
          credentialDigest: row.credentialDigest,
          credentialCiphertext: row.credentialCiphertext,
        }),
        dependencies: [],
      };
    }),
  );
  const last = rows.at(-1);
  return {
    pageKey: ref([
      "connector-remote-page",
      lease.jobId,
      lease.captureRevision,
      after ?? null,
    ]),
    inputCursorDigest: lease.item.cursorDigest,
    nextCursor:
      rows.length < PAGE_SIZE || !last
        ? null
        : await encryptErasureSelector({
            version: 1,
            kind: "cursor",
            after: JSON.stringify([last.ordinal, last.resourceId]),
          }),
    enumerationRef:
      rows.length < PAGE_SIZE
        ? ref([
            "connector-remote-enumeration",
            subject.subjectId,
            CONNECTOR_REMOTE_ERASURE_COLLECTOR_VERSION,
          ])
        : null,
    items,
  };
}

/** Connector cleanup currently treats token revocation and provider watch stop
 * as best-effort. An acknowledged local row deletion is not evidence that a
 * provider revoked credentials or stopped a watch. Retain these B1 locators as
 * explicit residuals until an authenticated terminal proof exists. */
export function createConnectorRemoteErasureCollector(db: Db): ErasureHandler {
  return {
    version: CONNECTOR_REMOTE_ERASURE_COLLECTOR_VERSION,
    inventory: async (lease, cursor) => {
      return await inventory(db, lease, cursor);
    },
    erase: async (lease, signal) => {
      signal.throwIfAborted();
      const resource = await selected(lease);
      if (
        resource?.kind !== "connector_remote" ||
        resource.connectorId === null
      ) {
        return unresolved("selector_missing");
      }
      await renewErasureLease(db, lease);
      return unresolved("boundary_unproven");
    },
    verify: async (
      lease,
      boundary,
      signal,
    ): Promise<ErasureProof | ErasureUnresolved> => {
      signal.throwIfAborted();
      const resource = await selected(lease);
      if (resource?.kind === "connector_remote") {
        return unresolved("boundary_unproven");
      }
      if (resource?.kind !== "subject" || resource.subjectKind !== "user") {
        return unresolved("selector_missing");
      }
      return {
        workId: lease.workId,
        sinkId: lease.item.sinkId,
        generation: lease.generation,
        captureRevision: lease.captureRevision,
        inventoryRevision: lease.inventoryRevision,
        producerBoundaryRef: boundary,
        outcome: "verified_no_applicable_data",
        evidenceRef: ref(["connector-remote-absence", lease.jobId]),
        authenticatedReaderRef: ref([
          "connector-remote-db-reader",
          CONNECTOR_REMOTE_ERASURE_COLLECTOR_VERSION,
        ]),
        enumerationRef: ref([
          "connector-remote-enumeration-proof",
          lease.item.itemKey,
        ]),
        observedAt: nowDate(),
      };
    },
  };
}
