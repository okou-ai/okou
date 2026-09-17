import { onTestFinished } from "vitest";

import {
  clearFeishuOAuthPersistenceHooksForTest,
  setFeishuOAuthPersistenceHooksForTest,
} from "../signals/routes/feishu-oauth";

export function holdFeishuOAuthBeforeErasureAdmissionFixture(
  hold: () => Promise<void>,
): void {
  setFeishuOAuthPersistenceHooksForTest({ beforeErasureAdmission: hold });
  onTestFinished(() => {
    clearFeishuOAuthPersistenceHooksForTest();
  });
}
