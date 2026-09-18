import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../index";
import { chatThreads } from "../schema/chat-thread";
import { slackChatIngress } from "../schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "../schema/slack-chat-thread-route";
import { slackOrgConnections } from "../schema/slack-org-connection";

describe("slackChatThreadRoutes schema", () => {
  it("exports the per-user Slack route table", () => {
    expect(schema.slackChatThreadRoutes).toBe(slackChatThreadRoutes);
  });

  it("keeps the per-user canonical route identity stable", () => {
    const config = getTableConfig(slackChatThreadRoutes);
    const columns = new Map(
      config.columns.map((column) => {
        return [column.name, column] as const;
      }),
    );
    const routeKey = config.indexes.find((index) => {
      return (
        index.config.name ===
        "idx_slack_chat_thread_routes_conn_channel_thread_user"
      );
    });

    expect(
      routeKey?.config.columns.map((column) => {
        return "name" in column ? column.name : undefined;
      }),
    ).toStrictEqual(["connection_id", "channel_id", "thread_ts", "user_id"]);
    expect(columns.get("connection_id")?.notNull).toBeTruthy();
    expect(columns.get("channel_id")?.notNull).toBeTruthy();
    expect(columns.get("thread_ts")?.notNull).toBeTruthy();
    expect(columns.get("user_id")?.notNull).toBeTruthy();
    expect(columns.get("chat_thread_id")?.notNull).toBeTruthy();
    expect(columns.has("backend")).toBeFalsy();
    expect(columns.has("legacy_cutover_event_id")).toBeFalsy();
    expect(columns.has("legacy_cutover_message_ts")).toBeFalsy();
    expect(
      config.foreignKeys.map((foreignKey) => {
        return foreignKey.reference().foreignTable;
      }),
    ).toEqual(expect.arrayContaining([slackOrgConnections, chatThreads]));
    expect(config.checks).toHaveLength(0);
  });
});

describe("slackChatIngress schema", () => {
  it("exports the canonical Slack ingress table", () => {
    expect(schema.slackChatIngress).toBe(slackChatIngress);
  });

  it("deduplicates Slack event IDs and tracks processing state", () => {
    const config = getTableConfig(slackChatIngress);
    const eventKey = config.indexes.find((index) => {
      return index.config.name === "idx_slack_chat_ingress_event_id";
    });
    const columns = new Map(
      config.columns.map((column) => {
        return [column.name, column] as const;
      }),
    );

    expect(
      eventKey?.config.columns.map((column) => {
        return "name" in column ? column.name : undefined;
      }),
    ).toStrictEqual(["event_id"]);
    expect(eventKey?.config.unique).toBeTruthy();
    expect(columns.get("route_id")?.notNull).toBeTruthy();
    expect(columns.get("event_id")?.notNull).toBeTruthy();
    expect(columns.get("payload")?.notNull).toBeTruthy();
    expect(columns.get("status")?.notNull).toBeTruthy();
    expect(columns.get("retry_count")?.notNull).toBeTruthy();
    expect(columns.get("processing_attempt_count")?.notNull).toBeTruthy();
    expect(columns.get("retry_at")?.notNull).toBeFalsy();
    expect(columns.get("last_error_class")?.notNull).toBeFalsy();
    expect(
      config.foreignKeys.map((foreignKey) => {
        return foreignKey.reference().foreignTable;
      }),
    ).toContain(slackChatThreadRoutes);
    expect(
      config.checks.map((check) => {
        return check.name;
      }),
    ).toEqual(
      expect.arrayContaining([
        "chk_slack_chat_ingress_status",
        "chk_slack_chat_ingress_retry_count",
        "chk_slack_chat_ingress_processing_attempt_count",
      ]),
    );
  });
});
