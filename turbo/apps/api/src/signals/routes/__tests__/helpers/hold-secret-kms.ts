import { createDeferredPromise } from "../../../utils";
import { useSecretKmsProbe } from "./secret-kms-probe";

export function holdSecretKms(callToHold: number, signal: AbortSignal) {
  const entered = createDeferredPromise<void>(signal);
  const released = createDeferredPromise<void>(signal);
  useSecretKmsProbe((request, callNumber) => {
    if (callNumber !== callToHold) {
      return undefined;
    }
    return (async () => {
      entered.resolve();
      await released.promise;
      return {
        keyId: request.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
        encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
      };
    })();
  });
  return {
    entered: entered.promise,
    release: () => {
      if (!released.settled()) {
        released.resolve();
      }
    },
  };
}
