import { GetObjectCommand } from "@aws-sdk/client-s3";
import { onTestFinished } from "vitest";

import type { TestContext } from "../../../../__tests__/test-context";
import { createDeferredPromise } from "../../../utils";

/** Hold a cold download signature while the test observes the pending Run. */
export function holdDownloadSigning(context: TestContext) {
  const presigner = context.mocks.s3.getSignedUrl;
  const sign = presigner.getMockImplementation();
  if (!sign) {
    throw new Error("Expected the external presigner fixture");
  }
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  const pendingNotice = createDeferredPromise<void>(context.signal);
  const realtime = context.mocks.ably.publish;
  const publish = realtime.getMockImplementation();
  const observePending = async (...args: unknown[]) => {
    if (args[0] === "chatIndicatorsChanged" && !pendingNotice.settled()) {
      pendingNotice.resolve();
    }
    return await publish?.(...args);
  };
  const hold = async (...args: unknown[]) => {
    if (args[1] instanceof GetObjectCommand && !entered.settled()) {
      entered.resolve();
      await released.promise;
    }
    return await sign(...args);
  };
  const release = () => {
    if (presigner.getMockImplementation() === hold) {
      presigner.mockImplementation(sign);
    }
    if (realtime.getMockImplementation() === observePending) {
      if (publish) {
        realtime.mockImplementation(publish);
      } else {
        realtime.mockReset();
      }
    }
    if (!released.settled()) {
      released.resolve();
    }
  };
  onTestFinished(release);
  presigner.mockImplementation(hold);
  realtime.mockImplementation(observePending);
  return {
    async waitForPending() {
      // The authoritative notification follows commit. Signing may start first.
      await Promise.all([entered.promise, pendingNotice.promise]);
    },
    release,
  };
}
