import { z } from "zod";

// Inventory names identify a reviewed host entry; they are never URL authority.
const inventoryHostnameSchema = z
  .string()
  .max(255)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine((name) => {
    return name.split(".").every((label) => {
      return (
        label.length > 0 &&
        label.length <= 63 &&
        !label.startsWith("-") &&
        !label.endsWith("-")
      );
    });
  });

const wssOriginSchema = z
  .string()
  .max(300)
  .superRefine((value, ctx) => {
    const hostname =
      /^wss:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+):443$/.exec(
        value,
      )?.[1];
    if (!hostname || hostname.length > 253 || hostname.endsWith(".localhost")) {
      ctx.addIssue({
        code: "custom",
        message: "Expected a canonical DNS WSS origin with explicit :443",
      });
      return;
    }
    // The host must be DNS, not an IP literal copied from a Runner claim.
    if (/^\d+(?:\.\d+){3}$/.test(hostname)) {
      ctx.addIssue({
        code: "custom",
        message: "IP literals are not WSS host origins",
      });
    }
  });

const entrySchema = z.strictObject({
  inventoryHostname: inventoryHostnameSchema,
  publicOrigin: wssOriginSchema,
});

/** The env parser accepts arrays so duplicate inventory names remain detectable. */
export const wssHostOriginsSchema = z
  .array(entrySchema)
  .max(256)
  .superRefine((entries, ctx) => {
    const names = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (names.has(entry.inventoryHostname)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "inventoryHostname"],
          message: "Duplicate inventory hostname",
        });
      }
      names.add(entry.inventoryHostname);
    }
  });

function releaseParts(value: string): readonly [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  const parts: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** A version floor is not configured until #37027 identifies a mandatory-listener release. */
export const wssMinimumRunnerVersionSchema = z
  .string()
  .max(128)
  .refine((value) => {
    return releaseParts(value) !== null;
  }, "Expected a release MAJOR.MINOR.PATCH");

export function supportsMandatoryWssListener(
  version: string,
  minimumVersion: string,
): boolean {
  const parts = releaseParts(version);
  const floor = releaseParts(minimumVersion);
  if (!parts || !floor || parts[0] !== floor[0]) {
    return false;
  }
  return parts[1] > floor[1] || (parts[1] === floor[1] && parts[2] >= floor[2]);
}
