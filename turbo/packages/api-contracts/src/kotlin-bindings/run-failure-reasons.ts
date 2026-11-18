import { knownRunFailureReasonSchema } from "../contracts/run-failure-reasons";
import { defaultKotlinPackage, kotlinHeader } from "./syntax";

/** Closed presentation cases; raw wire/cache tokens remain forward-compatible. */
export function renderKotlinRunFailureReasons(): string {
  const reasons = knownRunFailureReasonSchema.options;
  const cases = reasons.map((reason, index) => {
    const end = index === reasons.length - 1 ? ";" : ",";
    return `    ${reason.toUpperCase()}("${reason}")${end}`;
  });
  return [
    kotlinHeader(defaultKotlinPackage),
    "",
    "// Known at build time. Keep transport and cache values as raw strings.",
    "internal enum class KnownRunFailureReason(val wireValue: String) {",
    ...cases,
    "",
    "    companion object {",
    "        fun fromWireValue(value: String?): KnownRunFailureReason? =",
    "            entries.firstOrNull { it.wireValue == value }",
    "    }",
    "}",
    "",
  ].join("\n");
}
