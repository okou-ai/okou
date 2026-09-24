import "./env";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadAgentPhoneQueuedLaunchMaterial } from "../../src/signals/services/agentphone-queued-launch-context.service";
import { loadTelegramQueuedLaunchMaterial } from "../../src/signals/services/telegram-queued-launch-context.service";
import { loadTeamsQueuedLaunchMaterial } from "../../src/signals/services/teams-queued-launch-context.service";
import { loadGitHubQueuedLaunchMaterial } from "../../src/signals/services/github-queued-launch-context.service";
import { loadSlackQueuedLaunchMaterial } from "../../src/signals/services/slack-queued-launch-context.service";
import { loadFeishuQueuedLaunchMaterial } from "../../src/signals/services/feishu-queued-launch-context.service";
import {
  createUserMessageDocument,
  projectUserMessage,
} from "../../src/signals/services/chat-user-message.service";
import { insertChatEvent } from "../../src/signals/services/chat-event.service";
import { withNativeChatEventThreadTouch } from "../../src/signals/services/native-chat-event-write.service";
import { loadOptionalChatEnrichment } from "../../src/signals/services/queued-launch-enrichment.service";
import { flushLogs } from "../../src/lib/log";
import { assertLegacyErasureReplay } from "./erasure-compatibility";

// Infrastructure acceptance: missing server-private context is deliberately not
// constructible through public APIs. Readers use real PostgreSQL and migrated
// schemas; every row and the database belong to this process. No global switch,
// unrelated row, reader, or DB operation is mocked.
assert.ok(process.env.DATABASE_URL);
assert.ok(
  ["127.0.0.1", "localhost", "postgres"].includes(
    new URL(process.env.DATABASE_URL).hostname,
  ),
);
const suffix = randomUUID().replaceAll("-", "");
const databaseName = `chat_context_${suffix}`;
const databaseUrl = new URL(process.env.DATABASE_URL);
databaseUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: process.env.DATABASE_URL });
const client = new Client({ connectionString: databaseUrl.toString() });
const schema = `chat_context_${suffix}`;
const userId = `context-user-${suffix}`;
const orgId = `context-org-${suffix}`;
const agentId = randomUUID();
const canonical = createUserMessageDocument({
  text: "Original text survives missing history",
  files: [
    { id: randomUUID(), filename: "original.txt", contentType: "text/plain" },
  ],
});
const projection = projectUserMessage(canonical);
const warnings: unknown[][] = [];
mock.method(console, "log", (...args: unknown[]) => {
  warnings.push(args);
});
mock.method(globalThis, "fetch", () => {
  return Promise.resolve(new Response("{}", { status: 200 }));
});
const tables = [
  "agents",
  "chat_threads",
  "chat_events",
  "chat_event_write_control",
  "chat_event_sequences",
  "chat_thread_events",
  "chat_thread_event_sequences",
  "chat_agentphone_context",
  "agentphone_chat_thread_routes",
  "agentphone_user_links",
  "chat_telegram_context",
  "telegram_chat_thread_routes",
  "telegram_user_links",
  "telegram_official_user_links",
  "telegram_installations",
  "chat_teams_context",
  "teams_chat_thread_routes",
  "teams_org_connections",
  "teams_org_installations",
  "chat_github_context",
  "github_chat_thread_routes",
  "github_installations",
  "chat_slack_context",
  "slack_chat_ingress",
  "slack_chat_thread_routes",
  "slack_org_connections",
  "slack_org_installations",
  "chat_feishu_context",
  "feishu_chat_ingress",
  "feishu_chat_thread_routes",
  "feishu_org_connections",
  "feishu_org_installations",
];

async function event(channel: string) {
  const chatThreadId = randomUUID();
  const eventId = randomUUID();
  await client.query(
    "INSERT INTO chat_threads(id,user_id,agent_id) VALUES($1,$2,$3)",
    [chatThreadId, userId, agentId],
  );
  await client.query(
    "INSERT INTO chat_events(id,chat_thread_id,event_type,payload,context_type,context_id,seq_id) VALUES($1,$2,'input.prompt',$3,$4,$1,1)",
    [
      eventId,
      chatThreadId,
      JSON.stringify({ userMessage: canonical }),
      channel,
    ],
  );
  return {
    eventId,
    chatThreadId,
    userId,
    orgId,
    userMessageProjection: projection,
    featureSwitchContext: { userId, orgId },
  };
}

function original(
  material: {
    readonly prompt: string;
    readonly appendSystemPrompt: string;
  } | null,
) {
  assert.ok(material);
  assert.equal(material.prompt, projection.agentPrompt);
  assert.match(material.prompt, /Original text survives/);
  assert.match(material.prompt, /original\.txt/);
  assert.equal(material.appendSystemPrompt, "");
}

await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await promisify(execFile)("node", ["--import", "tsx", "scripts/migrate.ts"], {
    cwd: fileURLToPath(new URL("../../../../packages/db", import.meta.url)),
    env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
    maxBuffer: 20 * 1024 * 1024,
  });
  await client.connect();
  await assertLegacyErasureReplay(drizzle(client));
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  for (const table of tables) {
    await client.query(
      `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`,
    );
  }
  await client.query(
    "INSERT INTO agents(id,org_id,owner,name) VALUES($1,$2,$3,'context-acceptance')",
    [agentId, orgId, userId],
  );
  const db = drizzle(client);

  const phone = await event("agentphone");
  const phoneLink = randomUUID();
  await client.query(
    "INSERT INTO agentphone_user_links(id,phone_handle,user_id,org_id,public_brand) VALUES($1,'+15550001001',$2,$3,'okou')",
    [phoneLink, userId, orgId],
  );
  await client.query(
    "INSERT INTO agentphone_chat_thread_routes(agentphone_user_link_id,root_message_id,chat_thread_id,conversation_id,is_group,group_id,channel,from_number,to_number,agentphone_agent_id,delivery_message_id) VALUES($1,'phone-root',$2,'conversation',true,'group-42','imessage','+15550001001','+15550001002','phone-agent','message-1')",
    [phoneLink, phone.chatThreadId],
  );
  const phoneMaterial = await loadAgentPhoneQueuedLaunchMaterial(db, phone);
  original(phoneMaterial);
  assert.equal(phoneMaterial?.agentphoneDelivery.groupId, "group-42");
  assert.equal(phoneMaterial?.agentphoneDelivery.isGroup, true);
  assert.equal(
    await loadAgentPhoneQueuedLaunchMaterial(db, {
      ...phone,
      orgId: "wrong-org",
    }),
    null,
  );
  await client.query(
    "UPDATE agentphone_chat_thread_routes SET group_id=NULL WHERE chat_thread_id=$1",
    [phone.chatThreadId],
  );
  assert.equal(
    await loadAgentPhoneQueuedLaunchMaterial(db, phone),
    null,
    "unknown group must not redirect to a DM",
  );

  const telegram = await event("telegram");
  const tgLink = randomUUID();
  await client.query(
    "INSERT INTO telegram_official_user_links(id,telegram_user_id,user_id,org_id,public_brand) VALUES($1,'tg-user',$2,$3,'okou')",
    [tgLink, userId, orgId],
  );
  await client.query(
    "INSERT INTO telegram_chat_thread_routes(telegram_official_user_link_id,chat_id,root_message_id,chat_thread_id,message_thread_id,chat_type,delivery_message_id) VALUES($1,'-10042','301',$2,37,'supergroup','302')",
    [tgLink, telegram.chatThreadId],
  );
  const tgMaterial = await loadTelegramQueuedLaunchMaterial(db, telegram);
  original(tgMaterial);
  assert.equal(tgMaterial?.telegramDelivery.messageThreadId, 37);
  assert.equal(tgMaterial?.telegramDelivery.chatId, "-10042");
  assert.equal(
    await loadTelegramQueuedLaunchMaterial(db, {
      ...telegram,
      userId: "wrong-user",
    }),
    null,
  );

  const teams = await event("teams");
  const teamsConnection = randomUUID();
  await client.query(
    "INSERT INTO teams_org_installations(teams_tenant_id,org_id,public_brand,service_url) VALUES('tenant',$1,'okou','https://teams.invalid')",
    [orgId],
  );
  await client.query(
    "INSERT INTO teams_org_connections(id,teams_tenant_id,teams_user_id,user_id) VALUES($1,'tenant','teams-user',$2)",
    [teamsConnection, userId],
  );
  await client.query(
    "INSERT INTO teams_chat_thread_routes(connection_id,conversation_id,thread_id,user_id,chat_thread_id,conversation_type,channel_id,service_url) VALUES($1,'conversation','teams-thread',$2,$3,'channel','teams-channel','https://teams.invalid')",
    [teamsConnection, userId, teams.chatThreadId],
  );
  const teamsMaterial = await loadTeamsQueuedLaunchMaterial(db, teams);
  original(teamsMaterial);
  assert.equal(teamsMaterial?.teamsDelivery.threadId, "teams-thread");
  assert.equal(teamsMaterial?.teamsDelivery.channelId, "teams-channel");
  assert.equal(
    teamsMaterial?.teamsDelivery.activityId,
    "teams-thread",
    "channel fallback replies to the route thread rather than opening a new thread",
  );
  assert.equal(
    await loadTeamsQueuedLaunchMaterial(db, { ...teams, orgId: "wrong-org" }),
    null,
  );

  await client.query(
    "INSERT INTO chat_teams_context(id,chat_thread_id,tenant_id,conversation_id,conversation_type,channel_id,activity_id,thread_id,service_url,public_brand,sender_user_id,connection_id) VALUES($1,$2,'tenant','conversation','channel','teams-channel','precise-activity','teams-thread','https://teams.invalid','okou','teams-user',$3)",
    [teams.eventId, teams.chatThreadId, teamsConnection],
  );
  const partialTeams = await loadTeamsQueuedLaunchMaterial(db, teams);
  original(partialTeams);
  assert.equal(
    partialTeams?.teamsDelivery.activityId,
    "precise-activity",
    "available precise references survive missing supplemental text",
  );

  const github = await event("github");
  const ghInstallation = randomUUID();
  await client.query(
    "INSERT INTO github_installations(id,org_id,public_brand) VALUES($1,$2,'okou')",
    [ghInstallation, orgId],
  );
  await client.query(
    "INSERT INTO github_chat_thread_routes(installation_id,repo,subject_number,subject_kind,user_id,chat_thread_id) VALUES($1,'example/repo',42,'pull_request',$2,$3)",
    [ghInstallation, userId, github.chatThreadId],
  );
  const ghMaterial = await loadGitHubQueuedLaunchMaterial(db, github);
  original(ghMaterial);
  assert.equal(ghMaterial?.githubDelivery.subjectKind, "pull_request");
  assert.equal(
    await loadGitHubQueuedLaunchMaterial(db, {
      ...github,
      userId: "wrong-user",
    }),
    null,
  );

  await client.query(
    "INSERT INTO chat_github_context(id,chat_thread_id,repo,subject_number,subject_kind,trigger_comment_id,public_brand) VALUES($1,$2,'example/repo',42,'pull_request','987','okou')",
    [github.eventId, github.chatThreadId],
  );
  const partialGitHub = await loadGitHubQueuedLaunchMaterial(db, github);
  original(partialGitHub);
  assert.equal(partialGitHub?.githubDelivery.triggerCommentId, "987");

  const slack = await event("slack");
  const slackConnection = randomUUID();
  const slackRoute = randomUUID();
  await client.query(
    "INSERT INTO slack_org_installations(slack_workspace_id,org_id,encrypted_bot_token,bot_user_id) VALUES('workspace',$1,'synthetic','bot')",
    [orgId],
  );
  await client.query(
    "INSERT INTO slack_org_connections(id,slack_user_id,slack_workspace_id,user_id) VALUES($1,'slack-user','workspace',$2)",
    [slackConnection, userId],
  );
  await client.query(
    "INSERT INTO slack_chat_thread_routes(id,connection_id,channel_id,thread_ts,user_id,chat_thread_id) VALUES($1,$2,'channel','1.0',$3,$4)",
    [slackRoute, slackConnection, userId, slack.chatThreadId],
  );
  await client.query(
    "INSERT INTO slack_chat_ingress(id,route_id,event_id,payload,public_brand) VALUES($1,$2,'slack-event',$3,'okou')",
    [
      slack.eventId,
      slackRoute,
      JSON.stringify({
        team_id: "workspace",
        event: {
          channel: "channel",
          user: "slack-user",
          ts: "2.0",
          thread_ts: "1.0",
        },
      }),
    ],
  );
  const slackMaterial = await loadSlackQueuedLaunchMaterial(db, slack);
  original(slackMaterial);
  assert.equal(slackMaterial?.slackDelivery.threadTs, "1.0");
  assert.equal(
    await loadSlackQueuedLaunchMaterial(db, { ...slack, userId: "wrong-user" }),
    null,
  );

  const replacementId = randomUUID();
  await client.query(
    "INSERT INTO chat_events(id,chat_thread_id,event_type,payload,context_type,context_id,seq_id) VALUES($1,$2,'input.prompt',$3,'slack',$4,2)",
    [
      replacementId,
      slack.chatThreadId,
      JSON.stringify({ userMessage: canonical }),
      slack.eventId,
    ],
  );
  original(
    await loadSlackQueuedLaunchMaterial(db, {
      ...slack,
      eventId: replacementId,
    }),
  );
  await client.query("UPDATE slack_chat_ingress SET payload=$1 WHERE id=$2", [
    JSON.stringify({
      team_id: "workspace",
      event: {
        channel: "wrong-channel",
        user: "slack-user",
        ts: "2.0",
        thread_ts: "1.0",
      },
    }),
    slack.eventId,
  ]);
  assert.equal(
    await loadSlackQueuedLaunchMaterial(db, slack),
    null,
    "ingress destination mismatch cannot redirect delivery",
  );

  const feishu = await event("feishu");
  const fsInstallation = randomUUID();
  const fsConnection = randomUUID();
  const connector = randomUUID();
  await client.query(
    "INSERT INTO feishu_org_installations(id,org_id,platform,app_id,feishu_tenant_key,public_brand,encrypted_app_secret,encrypted_verification_token,encrypted_encrypt_key) VALUES($1,$2,'feishu','app','tenant','okou','synthetic','synthetic','synthetic')",
    [fsInstallation, orgId],
  );
  await client.query(
    "INSERT INTO feishu_org_connections(id,installation_id,feishu_open_id,user_id,connector_id) VALUES($1,$2,'open-id',$3,$4)",
    [fsConnection, fsInstallation, userId, connector],
  );
  await client.query(
    "INSERT INTO feishu_chat_thread_routes(connection_id,chat_id,thread_id,user_id,chat_thread_id) VALUES($1,'feishu-chat','feishu-root',$2,$3)",
    [fsConnection, userId, feishu.chatThreadId],
  );
  await client.query(
    "INSERT INTO feishu_chat_ingress(id,installation_id,event_id,payload,public_brand) VALUES($1,$2,'feishu-event',$3,'okou')",
    [
      feishu.eventId,
      fsInstallation,
      JSON.stringify({
        installationId: fsInstallation,
        tenantKey: "tenant",
        appId: "app",
        messageId: "feishu-message",
        chatId: "feishu-chat",
        chatType: "group",
        rootId: "feishu-root",
        threadId: null,
        parentId: null,
        openId: "open-id",
      }),
    ],
  );
  const fsMaterial = await loadFeishuQueuedLaunchMaterial(db, feishu);
  original(fsMaterial);
  assert.equal(fsMaterial?.connectorSourceId, connector);
  assert.equal(fsMaterial?.feishuDelivery.threadId, "feishu-root");
  assert.equal(
    await loadFeishuQueuedLaunchMaterial(db, { ...feishu, orgId: "wrong-org" }),
    null,
  );

  const controller = new AbortController();
  const failOptionalLookup = () => {
    return Promise.reject(new Error("Never log enrichment payload"));
  };
  await assert.rejects(
    loadOptionalChatEnrichment(
      db,
      "telegram",
      failOptionalLookup,
      () => {
        return "";
      },
      controller.signal,
    ),
  );
  await client.query(
    "INSERT INTO chat_event_write_control(id,activated_at) VALUES('global',now())",
  );
  assert.equal(
    await loadOptionalChatEnrichment(
      db,
      "telegram",
      failOptionalLookup,
      () => {
        return "";
      },
      controller.signal,
    ),
    "",
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    loadOptionalChatEnrichment(
      db,
      "telegram",
      () => {
        return Promise.reject(cancelled.signal.reason);
      },
      () => {
        return "";
      },
      cancelled.signal,
    ),
    { name: "AbortError" },
  );

  await client.query(
    `CREATE FUNCTION ${schema}.reject_context() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'context storage failure'; END $$`,
  );
  await client.query(
    `CREATE TRIGGER reject_context BEFORE INSERT ON chat_agentphone_context FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_context()`,
  );
  await client.query(
    "INSERT INTO chat_event_sequences(chat_thread_id,last_seq_id) VALUES($1,1)",
    [phone.chatThreadId],
  );
  const committedEventId = randomUUID();
  await client.query(
    `CREATE FUNCTION ${schema}.reject_thread_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'thread activity storage failure'; END $$`,
  );
  await client.query(
    `CREATE TRIGGER reject_thread_touch BEFORE UPDATE ON chat_threads FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_thread_touch()`,
  );
  const committed = await withNativeChatEventThreadTouch(
    db,
    {
      splitWrites: true,
      chatThreadId: phone.chatThreadId,
      createdAt: new Date(),
      eventId: committedEventId,
    },
    async (writer, touchThread) => {
      const appended = await insertChatEvent(
        writer,
        {
          id: committedEventId,
          chatThreadId: phone.chatThreadId,
          eventType: "input.prompt",
          userMessage: canonical,
          runId: null,
          agentphoneContext: {
            messageText: "Never log enrichment payload",
            threadContext: "Never log enrichment payload",
            messageId: "message-2",
            rootMessageId: "phone-root",
            conversationId: "conversation",
            groupId: "group-42",
            channel: "imessage",
            isGroup: true,
            phoneHandle: "+15550001001",
            fromNumber: "+15550001001",
            toNumber: "+15550001002",
            userLinkId: phoneLink,
            agentphoneAgentId: "phone-agent",
            publicBrand: "okou",
          },
        },
        "id",
        { splitWrites: true },
      );
      await touchThread();
      return appended;
    },
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM chat_thread_events WHERE chat_thread_id=$1 AND kind='sort_touched'",
        [phone.chatThreadId],
      )
    ).rows[0]?.count,
    1,
    "native activity failure must still attempt the independent sort event",
  );
  assert.equal(
    committed?.id,
    committedEventId,
    "context SQL failure must not roll back the event append",
  );
  const afterFailure = await loadAgentPhoneQueuedLaunchMaterial(db, {
    ...phone,
    eventId: committedEventId,
  });
  original(afterFailure);
  assert.equal(afterFailure?.agentphoneDelivery.groupId, "group-42");
  assert.ok(
    warnings.every((entry) => {
      return !JSON.stringify(entry).includes("Never log enrichment payload");
    }),
  );

  assert.equal(
    warnings.filter((entry) => {
      return String(entry[0]).includes("Optional queued launch enrichment");
    }).length,
    10,
  );
  assert.ok(
    warnings.every((entry) => {
      return !JSON.stringify(entry).includes("Original text survives");
    }),
    "warns must not log prompt content",
  );
  process.stdout.write(
    "Chat context acceptance passed: six scoped delivery fallbacks preserve canonical input, topics, groups and identity.\n",
  );
} finally {
  await flushLogs();
  await client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
  mock.restoreAll();
}
