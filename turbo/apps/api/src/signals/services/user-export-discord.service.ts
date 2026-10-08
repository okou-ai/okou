import { chatDiscordContext } from "@okouai/db/schema/chat-discord-context";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { discordUserDmPreferences } from "@okouai/db/schema/discord-user-dm-preference";
import { and, asc, eq, getTableColumns, gt, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import { command } from "ccstate";
import { db$ } from "../external/db";

export const discordExportKindSchema = z.enum([
  "installations",
  "connections",
  "dm-preferences",
  "routes",
  "ingress",
  "contexts",
]);

type DiscordExportKind = z.infer<typeof discordExportKindSchema>;

interface DiscordExportArgs {
  readonly userId: string;
  readonly kind: DiscordExportKind;
  readonly cursor?: string;
  readonly startedAt: Date;
}

const PAGE_SIZE = 100;

/** Each page is account-scoped, including ingress accepted before a route exists. */
const readDiscordInstallationsPage$ = command(
  async ({ get }, args: DiscordExportArgs, signal: AbortSignal) => {
    const db = get(db$);
    const { userId, cursor, startedAt } = args;
    const rows = await db
      .select({
        key: discordOrgInstallations.guildId,
        row: getTableColumns(discordOrgInstallations),
      })
      .from(discordOrgInstallations)
      .where(
        and(
          eq(discordOrgInstallations.installedByUserId, userId),
          lte(discordOrgInstallations.createdAt, startedAt),
          cursor ? gt(discordOrgInstallations.guildId, cursor) : undefined,
        ),
      )
      .orderBy(asc(discordOrgInstallations.guildId))
      .limit(PAGE_SIZE);
    signal.throwIfAborted();
    return rows;
  },
);

export const readDiscordUserExportPage$ = command(
  async ({ get, set }, args: DiscordExportArgs, signal: AbortSignal) => {
    const db = get(db$);
    const { userId, cursor, startedAt } = args;
    const connections = db
      .select({ id: discordOrgConnections.id })
      .from(discordOrgConnections)
      .where(eq(discordOrgConnections.userId, userId));

    const read = async () => {
      switch (args.kind) {
        case "installations": {
          return await set(readDiscordInstallationsPage$, args, signal);
        }
        case "connections": {
          return await db
            .select({
              key: discordOrgConnections.id,
              row: getTableColumns(discordOrgConnections),
            })
            .from(discordOrgConnections)
            .where(
              and(
                eq(discordOrgConnections.userId, userId),
                lte(discordOrgConnections.createdAt, startedAt),
                cursor ? gt(discordOrgConnections.id, cursor) : undefined,
              ),
            )
            .orderBy(asc(discordOrgConnections.id))
            .limit(PAGE_SIZE);
        }
        case "dm-preferences": {
          return await db
            .select({
              key: discordUserDmPreferences.discordUserId,
              row: getTableColumns(discordUserDmPreferences),
            })
            .from(discordUserDmPreferences)
            .where(
              and(
                eq(discordUserDmPreferences.userId, userId),
                lte(discordUserDmPreferences.createdAt, startedAt),
                cursor
                  ? gt(discordUserDmPreferences.discordUserId, cursor)
                  : undefined,
              ),
            )
            .orderBy(asc(discordUserDmPreferences.discordUserId))
            .limit(PAGE_SIZE);
        }
        case "routes": {
          return await db
            .select({
              key: discordChatThreadRoutes.id,
              row: getTableColumns(discordChatThreadRoutes),
            })
            .from(discordChatThreadRoutes)
            .where(
              and(
                inArray(discordChatThreadRoutes.connectionId, connections),
                lte(discordChatThreadRoutes.createdAt, startedAt),
                cursor ? gt(discordChatThreadRoutes.id, cursor) : undefined,
              ),
            )
            .orderBy(asc(discordChatThreadRoutes.id))
            .limit(PAGE_SIZE);
        }
        case "ingress": {
          return await db
            .select({
              key: discordChatIngress.id,
              // Lease tokens authorize a worker claim and are not user content.
              row: {
                id: discordChatIngress.id,
                connectionId: discordChatIngress.connectionId,
                routeId: discordChatIngress.routeId,
                eventId: discordChatIngress.eventId,
                messageId: discordChatIngress.messageId,
                payload: discordChatIngress.payload,
                status: discordChatIngress.status,
                createdAt: discordChatIngress.createdAt,
                updatedAt: discordChatIngress.updatedAt,
              },
            })
            .from(discordChatIngress)
            .where(
              and(
                inArray(discordChatIngress.connectionId, connections),
                lte(discordChatIngress.createdAt, startedAt),
                cursor ? gt(discordChatIngress.id, cursor) : undefined,
              ),
            )
            .orderBy(asc(discordChatIngress.id))
            .limit(PAGE_SIZE);
        }
        case "contexts": {
          return await db
            .select({
              key: chatDiscordContext.id,
              row: getTableColumns(chatDiscordContext),
            })
            .from(chatDiscordContext)
            .where(
              and(
                inArray(
                  chatDiscordContext.routeId,
                  db
                    .select({ id: discordChatThreadRoutes.id })
                    .from(discordChatThreadRoutes)
                    .where(
                      inArray(
                        discordChatThreadRoutes.connectionId,
                        connections,
                      ),
                    ),
                ),
                lte(chatDiscordContext.createdAt, startedAt),
                cursor ? gt(chatDiscordContext.id, cursor) : undefined,
              ),
            )
            .orderBy(asc(chatDiscordContext.id))
            .limit(PAGE_SIZE);
        }
      }
    };
    const rows = await read();
    signal.throwIfAborted();
    return rows;
  },
);

export function nextDiscordUserExportKind(
  kind: DiscordExportKind,
): DiscordExportKind | undefined {
  return discordExportKindSchema.options.at(
    discordExportKindSchema.options.indexOf(kind) + 1,
  );
}
