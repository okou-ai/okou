import { onTestFinished } from "vitest";

import {
  clearUserPermissionGrantMutationHooksForTest,
  setUserPermissionGrantMutationHooksForTest,
} from "../signals/services/user-permission-grants.service";

export function holdUserPermissionGrantMutationBeforeAdmissionFixture(
  hold: () => Promise<void>,
): void {
  setUserPermissionGrantMutationHooksForTest({ beforeAdmission: hold });
  onTestFinished(() => {
    clearUserPermissionGrantMutationHooksForTest();
  });
}
