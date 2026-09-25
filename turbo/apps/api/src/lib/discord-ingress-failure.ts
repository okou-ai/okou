/** A classified ingress failure controls the durable retry policy. */
export class DiscordIngressFailure extends Error {
  constructor(
    readonly errorClass: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number,
    message: string,
  ) {
    super(message);
    this.name = "DiscordIngressFailure";
  }
}
