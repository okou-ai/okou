import type { Script } from "node:vm";

export interface Construction {
  kind: "schema" | "check" | "other";
  name: string;
  type: string;
}
export interface Evaluation {
  values: unknown;
  construction: Construction[] | undefined;
  initInvocations: number | undefined;
}
export function compileScript(javascript: string, filename?: string): Script;
export function evaluateScript(
  script: Script,
  instrumented?: boolean,
): Evaluation;
export function evaluate(
  javascript: string,
  instrumented?: boolean,
): Evaluation;
export function verifyRetained(values: unknown, expected: number): void;
