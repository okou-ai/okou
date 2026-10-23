import type { WorkflowImportSource } from "@okouai/api-contracts/contracts/workflow-import-source";
import { nowDate } from "../../lib/time";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import { publishUserSignal } from "../external/realtime";
import { settleIncludingAbort } from "../utils";

interface SkillImportIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly sessionId: string | null;
  readonly provider: WorkflowImportSource;
}

/** Server facts are distinct from client display/copy events; no content or credential is recorded. */
export async function recordSkillImportFact(
  fact: SkillImportIdentity & {
    readonly event: "session_created" | "skill_imported";
  },
): Promise<void> {
  await settleIncludingAbort(() => {
    return ingestToAxiom(getDatasetName("web-logs"), [
      {
        _time: nowDate().toISOString(),
        type: "skill_import",
        source: "api",
        ...fact,
      },
    ]);
  });
}

/** The request finalizer owns this observer even if its response is cancelled. */
export async function publishSkillImportAfterCommit(
  publication: Promise<{ readonly kind: "created" | "error" }>,
  identity: SkillImportIdentity,
): Promise<void> {
  const result = await settleIncludingAbort(publication);
  if (!result.ok || result.value.kind !== "created") {
    return;
  }
  await Promise.all([
    recordSkillImportFact({ ...identity, event: "skill_imported" }),
    publishUserSignal([identity.userId], "skillImportChanged"),
  ]);
}
