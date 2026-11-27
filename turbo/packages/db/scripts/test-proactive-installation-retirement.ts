import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { retireProactiveInstallations } from "./proactive-retirement/retire";

/** The migration suite creates a disposable, empty clone for this cross-release rehearsal. */
export async function validateProactiveInstallationRetirement(
  databaseUrl: string,
) {
  const db = postgres(databaseUrl, { max: 1 });
  const org = "retirement-test-org";
  const user = "retirement-test-owner";
  const first = "1".repeat(40);
  const second = "2".repeat(40);
  const brief = randomUUID(),
    planning = randomUUID(),
    ordinary = randomUUID();
  const thread = randomUUID(),
    oldThread = randomUUID(),
    run = randomUUID();
  const automation = randomUUID(),
    userAutomation = randomUUID();
  const event = randomUUID(),
    callback = randomUUID(),
    context = randomUUID();
  const paused = randomUUID();
  const pausedThread = randomUUID();
  const snapshot = {
    lifecycle: "retired",
    revision: {
      definition: {
        schemaVersion: 2,
        name: "proactive-planning",
        revision: "a".repeat(64),
        blueprints: [],
        workflow: {
          displayName: "Planning",
          description: "Archived plan",
          instruction: "Open the plan.",
          files: [{ path: "references/plan.md", content: "Original plan" }],
        },
      },
      contentBundle: { sha256: "b".repeat(64), archiveBytes: 210 },
    },
  };
  const provenance = {
    schemaVersion: 2,
    definitions: [
      {
        name: "morning-brief",
        revision: "c".repeat(64),
        contentBundle: { sha256: "d".repeat(64), archiveBytes: 210 },
      },
    ],
  };
  try {
    assert.deepEqual(await retireProactiveInstallations(db, first), {
      status: "nothing-to-retire",
    });
    await db`INSERT INTO org_members_metadata(org_id,user_id,timezone) VALUES(${org},${user},'UTC')`;
    await db`INSERT INTO chat_threads(id,org_id,user_id,hidden) VALUES
      (${thread},${org},${user},true),(${oldThread},${org},${user},true),(${pausedThread},${org},${user},true)`;
    await db`INSERT INTO workflows(id,org_id,owner_user_id,name,official_definition_name,archived_official_snapshot,created_by,updated_by)
      VALUES (${brief},${org},${user},'morning-brief','morning-brief',null,${user},${user}),
      (${planning},${org},${user},'proactive-planning','proactive-planning',${db.json(snapshot)},${user},${user}),
      (${paused},${org},${user},'agent-suggestions','agent-suggestions',NULL,${user},${user}),
      (${ordinary},${org},${user},'morning-brief',NULL,NULL,${user},${user})`;
    await db`INSERT INTO workflow_automations(id,org_id,owner_user_id,workflow_id,kind,schedule_type,cron_expression,
      official_blueprint_key, official_applied_fingerprint,official_parameter_bindings,official_reconciliation_status,official_intended_enabled)
      VALUES (${automation},${org},${user},${brief},'schedule','cron','50 6 * * *',
      'daily-delivery',repeat('a',64),'[]','current',true),
      (${userAutomation},${org},${user},${ordinary},'schedule','cron','30 8 * * *',NULL,NULL,NULL,NULL,NULL)`;
    await db`INSERT INTO workflow_user_automation_threads(org_id,user_id,workflow_id,chat_thread_id)
      VALUES (${org},${user},${brief},${thread}),(${org},${user},${planning},${oldThread}),(${org},${user},${paused},${pausedThread})`;
    await db`INSERT INTO morning_brief_enrollments(org_id,user_id,state) VALUES (${org},${user},'completed')`;
    await db`INSERT INTO agent_runs(id,org_id,user_id,prompt,status,trigger_source,autonomy_budget,chat_thread_id,
      workflow_automation_id,official_workflow_provenance)
      VALUES(${run},${org},${user},'Morning Brief','completed','automation-schedule',0,${thread},${automation},${db.json(provenance)})`;
    await db`INSERT INTO billing_run_attribution(run_id,org_id,user_id,run_started_at,source,credit_charge_policy)
      VALUES(${run},${org},${user},now(),'automation','official_workflow_free')`;
    assert.equal(
      (await retireProactiveInstallations(db, first)).status,
      "awaiting-standalone-dispatch",
    );
    await db`UPDATE proactive_dispatch_handoff SET phase='standalone'`;
    assert.equal(
      (await retireProactiveInstallations(db, first)).status,
      "first-compatible-release",
    );
    assert.equal(
      (await retireProactiveInstallations(db, second)).status,
      "awaiting-distinct-drained-release",
    );
    await db`UPDATE proactive_dispatch_handoff SET archive_reader_verified_at=now()-interval '6 minutes'`;
    assert.equal(
      (await retireProactiveInstallations(db, first)).status,
      "awaiting-distinct-drained-release",
    );
    const retire = () => {
      return retireProactiveInstallations(db, second);
    };
    await assert.rejects(retire, /member choice has no standalone schedule/);
    await db`INSERT INTO proactive_schedules(org_id,user_id,task,intended_enabled,enabled,timezone,consecutive_failures,preference_revision)
      VALUES(${org},${user},'morning-brief',false,false,'UTC',0,5)`;
    await db`INSERT INTO chat_automation_context(id,chat_thread_id,automation_id,event_type)
      VALUES(${context},${thread},${automation},'schedule')`;
    await db`INSERT INTO chat_events(id,chat_thread_id,seq_id,event_type,context_type,context_id)
      VALUES(${event},${thread},1,'input.automation','automation',${context})`;
    assert.deepEqual(await retire(), {
      status: "awaiting-legacy-work",
      reason: "Pending legacy input prevents retirement",
    });
    await db`INSERT INTO chat_events(chat_thread_id,seq_id,event_type,context_type,context_id,run_id,revokes_event_id,payload)
      VALUES(${thread},2,'input.prompt','automation',${context},${run},${event},'{"userMessage":{"parts":[{"type":"text","text":"Morning Brief"}],"version":1}}')`;
    const manual = randomUUID();
    await db`INSERT INTO chat_events(id,chat_thread_id,seq_id,event_type,context_type,payload,required_official_workflow_ids)
      VALUES(${manual},${thread},3,'input.prompt','web','{"userMessage":{"parts":[{"type":"text","text":"Legacy prompt"}],"version":1}}',ARRAY[${brief}::uuid])`;
    assert.deepEqual(await retire(), {
      status: "awaiting-legacy-work",
      reason: "Pending legacy input prevents retirement",
    });
    await db`INSERT INTO chat_events(chat_thread_id,seq_id,event_type,revokes_event_id)
      VALUES(${thread},4,'control.revoke',${manual})`;
    await db`UPDATE agent_runs SET status='running' WHERE id=${run}`;
    assert.deepEqual(await retire(), {
      status: "awaiting-legacy-work",
      reason: "Nonterminal legacy run prevents retirement",
    });
    await db`UPDATE agent_runs SET status='completed' WHERE id=${run}`;
    await db`INSERT INTO agent_run_callbacks(id,run_id,internal_kind,status) VALUES(${callback},${run},'workflow-automation:cron','pending')`;
    assert.deepEqual(await retire(), {
      status: "awaiting-legacy-work",
      reason: "Pending legacy callback prevents retirement",
    });
    await db`UPDATE agent_run_callbacks SET status='delivered' WHERE id=${callback}`;
    await db`INSERT INTO morning_brief_schedule_claims(automation_id,workflow_id,org_id,owner_user_id,
      scheduled_anchor_at,claimed_at,claim_sequence) VALUES(${automation},${brief},${org},${user},now(),now(),1)`;
    assert.deepEqual(await retire(), {
      status: "awaiting-legacy-work",
      reason: "Unsettled legacy schedule claim prevents retirement",
    });
    await db`UPDATE morning_brief_schedule_claims SET settlement='completed',settled_at=now() WHERE automation_id=${automation}`;
    assert.equal(
      (await db`SELECT id FROM archived_proactive_workflows`).length,
      0,
    );
    await db`UPDATE workflow_automations SET official_blueprint_key='unknown' WHERE id=${automation}`;
    await assert.rejects(
      retire,
      /unrecognized or differently owned automation/,
    );
    await db`UPDATE workflow_automations SET official_blueprint_key='daily-delivery' WHERE id=${automation}`;
    await db`UPDATE chat_threads SET hidden=false WHERE id=${thread}`;
    await assert.rejects(retire, /Historical task thread is not hidden/);
    await db`UPDATE chat_threads SET hidden=true WHERE id=${thread}`;
    const concurrent = postgres(databaseUrl, { max: 1 });
    const outcomes = await Promise.all([
      retire(),
      retireProactiveInstallations(concurrent, second),
    ]).finally(() => {
      return concurrent.end();
    });
    const completed = outcomes.filter((outcome) => {
      return outcome.status === "retired";
    });
    assert.deepEqual(completed, [
      {
        status: "retired",
        workflows: 3,
        automations: 1,
        enrollments: 1,
        runs: 1,
        rollbackRelease: first,
      },
    ]);
    assert.deepEqual(await retire(), { status: "nothing-to-retire" });
    const [saved] =
      await db`SELECT w.id,w.archived_official_snapshot AS snapshot,t.id AS thread,t.hidden
      FROM archived_proactive_workflows w JOIN chat_threads t ON t.id=w.chat_thread_id
      WHERE w.id=${planning} AND w.org_id=${org} AND w.owner_user_id=${user}`;
    assert.deepEqual(
      { ...saved },
      { id: planning, snapshot, thread: oldThread, hidden: true },
    );
    const [schedule] =
      await db`SELECT chat_thread_id, enabled, intended_enabled, preference_revision
      FROM proactive_schedules WHERE org_id=${org} AND user_id=${user} AND task='morning-brief'`;
    assert.deepEqual(
      { ...schedule },
      {
        chat_thread_id: thread,
        enabled: false,
        intended_enabled: false,
        preference_revision: 5,
      },
    );
    const [pausedSchedule] =
      await db`SELECT chat_thread_id, intended_enabled, enabled, next_run_at
      FROM proactive_schedules WHERE org_id=${org} AND user_id=${user} AND task='suggestions'`;
    assert.deepEqual(
      { ...pausedSchedule },
      {
        chat_thread_id: pausedThread,
        intended_enabled: false,
        enabled: false,
        next_run_at: null,
      },
    );
    const [ordinarySource] =
      await db`SELECT w.id,a.id AS automation,a.enabled FROM workflows w JOIN workflow_automations a ON a.workflow_id=w.id
      WHERE w.org_id=${org} AND w.name='morning-brief'`;
    assert.deepEqual(
      { ...ordinarySource },
      { id: ordinary, automation: userAutomation, enabled: true },
    );
    const [history] =
      await db`SELECT r.workflow_automation_id, r.official_workflow_provenance, h.workflow_id,
      h.automation_id, b.credit_charge_policy, c.event_type, e.run_id FROM agent_runs r
      JOIN archived_proactive_workflow_runs h ON h.run_id=r.id JOIN billing_run_attribution b ON b.run_id=r.id
      JOIN chat_events e ON e.run_id=r.id JOIN chat_automation_context c ON c.id=e.context_id AND c.automation_id=h.automation_id
      WHERE r.id=${run}`;
    assert.deepEqual(
      { ...history },
      {
        workflow_automation_id: null,
        official_workflow_provenance: provenance,
        workflow_id: brief,
        automation_id: automation,
        credit_charge_policy: "official_workflow_free",
        event_type: "schedule",
        run_id: run,
      },
    );
  } finally {
    await db.end();
  }
}
