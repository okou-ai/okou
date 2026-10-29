import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import type { CdpClient } from "../cdp/client.ts";
import { CdpFault } from "../cdp/errors.ts";

type Method = keyof ProtocolMapping.Commands;
type Params<M extends Method> = ProtocolMapping.Commands[M]["paramsType"][0];
type Result<M extends Method> = ProtocolMapping.Commands[M]["returnType"];
type Outcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: unknown };

/** Acknowledgements belong to the original input session even after admission ends. */
export class InputEffects {
  private readonly pending = new Set<Promise<void>>();
  private failed = false;
  private imeSupported = false;
  private imeUnsupported = false;
  constructor(
    private readonly client: CdpClient,
    private readonly sessionId: string,
  ) {}

  async request<M extends Method>(
    method: M,
    params: Params<M>,
  ): Promise<Result<M>> {
    const outcome = await this.issue(method, params).receipt;
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.result;
  }
  notify<M extends Method>(method: M, params: Params<M>): void {
    this.issue(method, params);
  }
  private async receipt<M extends Method>(
    method: M,
    params: Params<M>,
  ): Promise<Outcome<Result<M>>> {
    const [result] = await Promise.allSettled([
      this.client.request(method, params, this.sessionId),
    ]);
    return result.status === "fulfilled"
      ? { ok: true, result: result.value }
      : { ok: false, error: result.reason };
  }
  private issue<M extends Method>(
    method: M,
    params: Params<M>,
  ): { receipt: Promise<Outcome<Result<M>>> } {
    if (this.pending.size >= 128) {
      this.failed = true;
      const error = new CdpFault("input", "Too many pending input effects.");
      this.client.close(error);
      return { receipt: Promise.resolve({ ok: false, error }) };
    }
    const receipt = this.receipt(method, params);
    const settled = (async () => {
      using _completion1 = {
        [Symbol.dispose]: () => {
          return this.pending.delete(settled);
        },
      };

      const outcome = await receipt;
      if (outcome.ok) {
        if (method === "Input.imeSetComposition") {
          this.imeSupported = true;
        }
      } else {
        const unsupported =
          method === "Input.imeSetComposition" &&
          outcome.error instanceof CdpFault &&
          outcome.error.code === -32_601;
        if (unsupported) {
          this.imeUnsupported = true;
        } else {
          this.failed = true;
        }
      }
    })();
    this.pending.add(settled);
    return { receipt };
  }
  async completion(): Promise<void> {
    await Promise.all(this.pending);
    if (this.failed || (this.imeSupported && this.imeUnsupported)) {
      throw new CdpFault("input", "Original input cleanup is unconfirmed.");
    }
  }
}
