import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { decode, object, string } from "./kms";

export interface BusinessCanaryConfiguration {
  readonly databaseUrl: string;
  readonly apiOrigin: string;
  readonly clerkBackendOrigin: string;
  readonly clerkFrontendOrigin: string;
  readonly appOrigin: string;
  readonly clerkSecret: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly targetKey: string;
  readonly sourceKey: string;
  readonly oldEnvelope: string;
  readonly oldLegacy: string;
}

export interface BusinessCanaryReport {
  readonly version: 1;
  readonly nonce: string;
  readonly startedAt: string;
  finishedAt?: string;
  phase: string;
  result: "running" | "passed" | "failed";
  checks: string[];
  cleanup: "pending" | "passed" | "failed";
  cleanupFailures: string[];
  readonly historicalCiphertextWrites: 0;
  fixtureWrites: number;
  resources: Record<string, string>;
  requestFailure?: { service: string; method: string; status: number };
}

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error("business_canary_invariant_failed");
}

function id(value: unknown): string {
  const result = string(value);
  requireValue(/^[a-zA-Z0-9_-]{1,128}$/u.test(result));
  return result;
}

/**
 * Exercise deployed writes and the deployed secret-reveal reader. Only an
 * exclusively owned, disabled webhook fixture receives direct database writes.
 * Connector ciphertext is read through that reader because connector GETs mask
 * secrets. This does not certify external connector calls or webhook delivery.
 */
export async function verifyBusinessCanary(
  config: BusinessCanaryConfiguration,
  checkpoint: (report: BusinessCanaryReport) => Promise<void>,
): Promise<BusinessCanaryReport> {
  const nonce = `kms32264-${randomUUID().replaceAll("-", "")}`;
  const report: BusinessCanaryReport = {
    version: 1,
    nonce,
    startedAt: new Date().toISOString(),
    phase: "connect",
    result: "running",
    checks: [],
    cleanup: "pending",
    cleanupFailures: [],
    historicalCiphertextWrites: 0,
    fixtureWrites: 0,
    resources: {},
  };
  const db = new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 15_000,
    application_name: nonce,
  });
  const cookies = new Map<string, string>();
  let jwt = "";
  let connected = false;
  let authenticated = false;
  let ticketConsumed = false;
  const started = Date.now();

  async function phase(name: string): Promise<void> {
    requireValue(Date.now() - started < 300_000);
    report.phase = name;
    await checkpoint(report);
  }

  async function http(
    origin: string,
    path: string,
    method: string,
    body: Record<string, unknown> | undefined,
    statuses: number[] = [200],
  ): Promise<Record<string, unknown>> {
    requireValue(path.startsWith("/") && !path.startsWith("//"));
    const frontend = origin === config.clerkFrontendOrigin;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (origin === config.clerkBackendOrigin) {
      headers.Authorization = `Bearer ${config.clerkSecret}`;
    } else if (origin === config.apiOrigin) {
      requireValue(authenticated);
      headers.Authorization = `Bearer ${jwt}`;
    } else {
      requireValue(frontend);
      headers.Origin = config.appOrigin;
      headers.Cookie = [...cookies.values()].join("; ");
    }
    let encoded: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = frontend
        ? "application/x-www-form-urlencoded"
        : "application/json";
      encoded = frontend
        ? new URLSearchParams(
            Object.entries(body).map(([key, value]): [string, string] => {
              return [key, string(value)];
            }),
          ).toString()
        : JSON.stringify(body);
    }
    const response = await fetch(origin + path, {
      method,
      headers,
      body: encoded,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (frontend) {
      for (const cookie of response.headers.getSetCookie()) {
        const pair = string(cookie.split(";")[0]);
        cookies.set(string(pair.split("=")[0]), pair);
      }
    }
    if (!statuses.includes(response.status)) {
      report.requestFailure = {
        service: frontend
          ? "clerk_frontend"
          : origin === config.apiOrigin
            ? "deployed_api"
            : "clerk_backend",
        method,
        status: response.status,
      };
      throw new Error("business_canary_http_failure");
    }
    const text = await response.text();
    requireValue(text.length < 262_144);
    return text ? object(JSON.parse(text)) : {};
  }

  const api = (
    path: string,
    method = "GET",
    body?: Record<string, unknown>,
    statuses = [200],
  ) => {
    return http(config.apiOrigin, path, method, body, statuses);
  };
  const clerk = (
    path: string,
    method = "GET",
    body?: Record<string, unknown>,
  ) => {
    return http(config.clerkBackendOrigin, `/v1${path}`, method, body);
  };
  const frontend = (
    path: string,
    method: string,
    body?: Record<string, unknown>,
  ) => {
    return http(
      config.clerkFrontendOrigin,
      `/v1${path}?__clerk_api_version=2026-05-12`,
      method,
      body,
    );
  };

  async function rows(
    sql: string,
    values: (string | null)[],
  ): Promise<Record<string, unknown>[]> {
    const result = await db.query(sql, values);
    return result.rows.map((row: unknown) => {
      return object(row);
    });
  }

  const owner = [config.orgId, config.userId, config.agentId, nonce];
  // Rediscover by a random namespace, not just HTTP response IDs, so a response
  // lost after a successful create still leaves discoverable cleanup targets.
  async function discover(): Promise<void> {
    const workflows = await rows(
      `SELECT id FROM workflows WHERE org_id=$1 AND owner_user_id=$2
       AND agent_id=$3 AND name=$4 AND visibility='private'`,
      owner,
    );
    requireValue(workflows.length <= 1);
    if (workflows[0]) {
      const workflowId = id(workflows[0].id);
      report.resources.workflowId = workflowId;
      const automations = await rows(
        `SELECT id, enabled FROM workflow_automations
         WHERE org_id=$1 AND owner_user_id=$2 AND workflow_id=$3`,
        [config.orgId, config.userId, workflowId],
      );
      requireValue(automations.length <= 1);
      if (automations[0]) {
        report.resources.automationId = id(automations[0].id);
      }
      const threads = await rows(
        `SELECT chat_thread_id FROM workflow_user_automation_threads
         WHERE org_id=$1 AND user_id=$2 AND workflow_id=$3`,
        [config.orgId, config.userId, workflowId],
      );
      requireValue(threads.length <= 1);
      if (threads[0]?.chat_thread_id) {
        report.resources.chatThreadId = id(threads[0].chat_thread_id);
      }
    }
    const connectors = await rows(
      `SELECT id FROM org_custom_connectors
       WHERE org_id=$1 AND created_by=$2 AND slug=$3 AND display_name=$4`,
      [config.orgId, config.userId, `_${nonce}`, nonce],
    );
    requireValue(connectors.length <= 1);
    if (connectors[0])
      report.resources.customConnectorId = id(connectors[0].id);
    await checkpoint(report);
  }

  async function webhook(): Promise<Record<string, unknown>> {
    const matches = await rows(
      `SELECT h.encrypted_token, h.encrypted_secret FROM workflow_webhook_automations h
       JOIN workflow_automations a ON a.id=h.automation_id
       JOIN workflows w ON w.id=a.workflow_id
       WHERE w.org_id=$1 AND w.owner_user_id=$2 AND w.agent_id=$3 AND w.name=$4
       AND w.visibility='private' AND a.org_id=w.org_id AND a.owner_user_id=w.owner_user_id
       AND a.id=$5 AND a.enabled=false AND a.event_type='webhook-received'
       AND a.last_run_id IS NULL AND h.last_received_at IS NULL`,
      [...owner, string(report.resources.automationId)],
    );
    requireValue(matches.length === 1);
    return object(matches[0]);
  }

  async function reveal(expected: string, expectedUrl: string): Promise<void> {
    const response = await api(
      `/api/workflow-automations/${string(report.resources.automationId)}/webhook-secret`,
      "POST",
    );
    requireValue(
      response.webhookSecret === expected &&
        response.webhookUrl === expectedUrl,
    );
  }

  async function installFixture(
    ciphertext: string,
    plaintext: string,
  ): Promise<void> {
    const before = await webhook();
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0363; new non-billing transactions are prohibited.
    await db.query("BEGIN READ WRITE");
    try {
      const changed = await rows(
        `UPDATE workflow_webhook_automations h SET encrypted_secret=$6, secret_last_four=$7
         FROM workflow_automations a, workflows w
         WHERE h.automation_id=a.id AND a.workflow_id=w.id
         AND w.org_id=$1 AND w.owner_user_id=$2 AND w.agent_id=$3 AND w.name=$4
         AND w.visibility='private' AND a.org_id=w.org_id AND a.owner_user_id=w.owner_user_id
         AND a.id=$5 AND a.enabled=false AND a.event_type='webhook-received'
         AND a.last_run_id IS NULL AND h.last_received_at IS NULL
         AND h.encrypted_secret=$8 AND h.encrypted_token=$9 RETURNING h.automation_id`,
        [
          ...owner,
          string(report.resources.automationId),
          ciphertext,
          plaintext.slice(-4),
          string(before.encrypted_secret),
          string(before.encrypted_token),
        ],
      );
      requireValue(changed.length === 1);
      await db.query("COMMIT");
      report.fixtureWrites++;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }

  async function cleanupStep(
    name: string,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch {
      report.cleanupFailures.push(name);
    }
  }

  await checkpoint(report);
  try {
    requireValue(decode(config.oldEnvelope).kms.keyId === config.sourceKey);
    requireValue(decode(config.oldEnvelope).kms.encryptedDataKey !== undefined);
    requireValue(decode(config.oldLegacy).kms.keyId === config.sourceKey);
    requireValue(decode(config.oldLegacy).kms.encryptedDataKey === undefined);
    await db.connect();
    connected = true;
    await db.query("SET default_transaction_read_only=on");
    await phase("authenticate");
    const memberships = await clerk(
      `/organizations/${id(config.orgId)}/memberships?user_id=${id(config.userId)}&limit=2`,
    );
    requireValue(
      Array.isArray(memberships.data) && memberships.data.length === 1,
    );
    const membership = object(memberships.data[0]);
    requireValue(
      object(membership.organization).id === config.orgId &&
        object(membership.organization).slug === "vm0" &&
        object(membership.public_user_data).user_id === config.userId &&
        membership.role === "org:admin",
    );
    await frontend("/client", "POST", {});
    requireValue(cookies.size > 0);
    const ticket = await clerk("/sign_in_tokens", "POST", {
      user_id: config.userId,
      org_id: config.orgId,
      expires_in_seconds: 60,
    });
    report.resources.signInTokenId = id(ticket.id);
    await checkpoint(report);
    const signedIn = object(
      (
        await frontend("/client/sign_ins", "POST", {
          strategy: "ticket",
          ticket: string(ticket.token),
        })
      ).response,
    );
    requireValue(signedIn.status === "complete");
    ticketConsumed = true;
    report.resources.sessionId = id(signedIn.created_session_id);
    await checkpoint(report);
    jwt = string(
      (
        await clerk(`/sessions/${report.resources.sessionId}/tokens`, "POST", {
          expires_in_seconds: 900,
        })
      ).jwt,
    );
    const claims = object(
      JSON.parse(
        Buffer.from(string(jwt.split(".")[1]), "base64url").toString(),
      ),
    );
    const orgId = claims.o === undefined ? claims.org_id : object(claims.o).id;
    requireValue(
      claims.sub === config.userId &&
        claims.sid === report.resources.sessionId &&
        orgId === config.orgId,
    );
    authenticated = true;
    await api(`/api/agents/${id(config.agentId)}`);
    await phase("webhook_create_read");
    await discover();
    requireValue(
      !report.resources.workflowId && !report.resources.customConnectorId,
    );
    const workflow = await api(
      "/api/workflows",
      "POST",
      {
        agentId: config.agentId,
        name: nonce,
        visibility: "private",
        instruction: "Temporary KMS migration verification fixture. Never run.",
      },
      [201],
    );
    report.resources.workflowId = id(workflow.id);
    await checkpoint(report);
    const automation = await api(
      `/api/workflows/${report.resources.workflowId}/automations`,
      "POST",
      {
        kind: "event",
        eventType: "webhook-received",
        enabled: false,
      },
      [201],
    );
    report.resources.automationId = id(automation.id);
    await discover();
    const original = await webhook();
    requireValue(
      decode(string(original.encrypted_token)).kms.keyId === config.targetKey,
    );
    requireValue(
      decode(string(original.encrypted_secret)).kms.keyId === config.targetKey,
    );
    const webhookUrl = string(automation.webhookUrl);
    await reveal(string(automation.webhookSecret), webhookUrl);
    report.checks.push("deployed_webhook_create_and_reveal_target_key");

    await phase("connector_create_update_read");
    const custom = await api(
      "/api/custom-connectors",
      "POST",
      {
        kind: "http",
        authMode: "manual",
        slug: `_${nonce}`,
        displayName: nonce,
        prefixTemplates: ["https://kms-canary.invalid/"],
        fields: [
          {
            key: "secret",
            label: "Synthetic secret",
            kind: "secret",
            required: true,
          },
        ],
        headerInjections: [
          { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
        ],
        queryInjections: [],
      },
      [201],
    );
    report.resources.customConnectorId = id(custom.id);
    await checkpoint(report);
    let previousCiphertext: string | undefined;
    for (const intent of ["add", "reconnect"]) {
      const plaintext = `${nonce}-${intent}`;
      const account =
        intent === "add"
          ? { intent, displayName: nonce }
          : { intent, connectionId: string(report.resources.connectionId) };
      const response = await api(
        `/api/custom-connectors/${report.resources.customConnectorId}/values`,
        "PUT",
        {
          values: [{ key: "secret", kind: "secret", value: plaintext }],
          account,
        },
      );
      const connectionId = id(response.connectedAccountId);
      requireValue(
        !report.resources.connectionId ||
          report.resources.connectionId === connectionId,
      );
      report.resources.connectionId = connectionId;
      await checkpoint(report);
      const stored = await rows(
        `SELECT s.encrypted_value FROM secrets s JOIN connectors c ON c.id=s.connector_id
         JOIN org_custom_connectors d ON d.id=c.custom_connector_id
         WHERE s.org_id=$1 AND s.user_id=$2 AND c.org_id=$1 AND c.user_id=$2
         AND d.org_id=$1 AND d.created_by=$2 AND d.slug=$3 AND d.display_name=$4
         AND c.id=$5 AND d.id=$6 AND s.type='connector'`,
        [
          config.orgId,
          config.userId,
          `_${nonce}`,
          nonce,
          connectionId,
          report.resources.customConnectorId,
        ],
      );
      requireValue(stored.length === 1);
      const ciphertext = string(object(stored[0]).encrypted_value);
      requireValue(
        decode(ciphertext).kms.keyId === config.targetKey &&
          ciphertext !== previousCiphertext,
      );
      await installFixture(ciphertext, plaintext);
      await reveal(plaintext, webhookUrl);
      previousCiphertext = ciphertext;
      report.checks.push(`deployed_connector_${intent}_and_shared_reader`);
    }
    await phase("source_ciphertext_read");
    for (const [name, ciphertext] of [
      ["envelope", config.oldEnvelope],
      ["legacy", config.oldLegacy],
    ]) {
      await installFixture(
        string(ciphertext),
        "kms-32264-production-synthetic-only",
      );
      await reveal("kms-32264-production-synthetic-only", webhookUrl);
      report.checks.push(`deployed_source_${string(name)}_read`);
    }
    await webhook();
    report.result = "passed";
  } catch {
    report.result = "failed";
  } finally {
    await cleanup();
  }
  return report;

  async function cleanup(): Promise<void> {
    if (connected && authenticated) {
      await cleanupStep("discover", discover);
      for (const [name, path] of [
        ["automationId", "/api/workflow-automations/"],
        ["chatThreadId", "/api/chat-threads/"],
        ["workflowId", "/api/workflows/"],
        ["customConnectorId", "/api/custom-connectors/"],
      ]) {
        const resource = report.resources[string(name)];
        if (resource)
          await cleanupStep(string(name), async () => {
            await api(
              string(path) + id(resource),
              "DELETE",
              undefined,
              [204, 404],
            );
          });
      }
      await cleanupStep("database_readback", async () => {
        const remaining = await rows(
          `SELECT id FROM workflows WHERE org_id=$1 AND owner_user_id=$2 AND agent_id=$3 AND name=$4
           UNION ALL SELECT id FROM org_custom_connectors WHERE org_id=$1 AND created_by=$2 AND display_name=$4
           UNION ALL SELECT id FROM secrets WHERE org_id=$1 AND user_id=$2 AND connector_id=$5::uuid
           UNION ALL SELECT id FROM workflow_automations WHERE id=$6::uuid
           UNION ALL SELECT id FROM chat_threads WHERE id=$7::uuid`,
          [
            ...owner,
            report.resources.connectionId ?? null,
            report.resources.automationId ?? null,
            report.resources.chatThreadId ?? null,
          ],
        );
        requireValue(remaining.length === 0);
      });
    }
    if (report.resources.sessionId)
      await cleanupStep("session_revoke", async () => {
        const response = await clerk(
          `/sessions/${id(report.resources.sessionId)}/revoke`,
          "POST",
          {},
        );
        requireValue(
          response.id === report.resources.sessionId &&
            response.status === "revoked",
        );
      });
    if (cookies.size)
      await cleanupStep("client_sessions_end", async () => {
        await frontend("/client", "DELETE");
      });
    if (report.resources.signInTokenId && !ticketConsumed)
      await cleanupStep("ticket_revoke", async () => {
        await clerk(
          `/sign_in_tokens/${id(report.resources.signInTokenId)}/revoke`,
          "POST",
          {},
        );
      });
    if (connected)
      await cleanupStep("database_disconnect", () => {
        return db.end();
      });
    report.cleanup = report.cleanupFailures.length ? "failed" : "passed";
    if (report.cleanup !== "passed") report.result = "failed";
    report.finishedAt = new Date().toISOString();
    await checkpoint(report);
  }
}
