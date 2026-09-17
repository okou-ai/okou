import { createDeferredPromise, settleIncludingAbort } from "../../../utils";
import { useSecretKmsProbe } from "./secret-kms-probe";

/** Hold the first bundle's external KMS calls; later API work remains live. */
export function holdSubscriptionKmsBatch(signal: AbortSignal) {
  const entered = createDeferredPromise<void>(signal);
  const first = createDeferredPromise<void>(signal);
  const second = createDeferredPromise<void>(signal);
  let firstFailure: Error | undefined;
  let secondFailure: Error | undefined;
  let active = 0;
  let peak = 0;
  const decrypt = async (call: number) => {
    active++;
    peak = Math.max(peak, active);
    const held = async () => {
      if (call === 2) {
        await first.promise;
        if (firstFailure) {
          throw firstFailure;
        }
      } else if (call === 3) {
        entered.resolve(undefined);
        await second.promise;
        if (secondFailure) {
          throw secondFailure;
        }
      }
      return Buffer.from("0123456789abcdef0123456789abcdef");
    };
    const result = await settleIncludingAbort(held());
    active--;
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  };
  const probe = useSecretKmsProbe(undefined, (_request, call) => {
    // Firewall auth first opens its captured KMS envelope. Hold only the
    // subsequent stored-credential bundle, not that independent envelope.
    return call === 1 ? undefined : decrypt(call);
  });
  return {
    entered: entered.promise,
    failFirst() {
      firstFailure = new Error("Synthetic KMS unavailable");
      first.resolve(undefined);
    },
    failSecond() {
      secondFailure = new Error("Synthetic mirror KMS unavailable");
      second.resolve(undefined);
    },
    release() {
      if (!first.settled()) {
        first.resolve(undefined);
      }
      if (!second.settled()) {
        second.resolve(undefined);
      }
    },
    get calls() {
      return probe.decryptCalls;
    },
    get active() {
      return active;
    },
    get peak() {
      return peak;
    },
  };
}
