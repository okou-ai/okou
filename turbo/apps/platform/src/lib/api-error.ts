export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly expected: boolean;

  constructor(message: string, code: string, status: number, expected = false) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.expected = expected;
  }
}
