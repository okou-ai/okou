import { fnv1a } from "@okouai/core/identity-hash";

const FNV_PRIME = 16_777_619;
// Multiplicative inverse of FNV_PRIME modulo 2^32.
const FNV_PRIME_INVERSE = 899_433_627;

function advanceFnv1a(hash: number, character: string): number {
  return Math.imul(hash ^ character.charCodeAt(0), FNV_PRIME) >>> 0;
}

function reverseFnv1a(hash: number, character: string): number {
  return (Math.imul(hash, FNV_PRIME_INVERSE) ^ character.charCodeAt(0)) >>> 0;
}

/** Find a test-owned identity in an existing production hash audience. */
export function identityHashCollisionSuffix(args: {
  readonly prefix: string;
  readonly targetHash: number;
  readonly alphabet: string;
  readonly rightLength: 3 | 4;
  readonly suffix?: string;
}): string | null {
  const prefixHash = Number.parseInt(fnv1a(args.prefix), 16);
  const firstHalves = new Map<number, string>();
  for (const first of args.alphabet) {
    for (const second of args.alphabet) {
      for (const third of args.alphabet) {
        const hash = advanceFnv1a(
          advanceFnv1a(advanceFnv1a(prefixHash, first), second),
          third,
        );
        firstHalves.set(hash, `${first}${second}${third}`);
      }
    }
  }
  let target = args.targetHash;
  for (const character of Array.from(args.suffix ?? "").reverse()) {
    target = reverseFnv1a(target, character);
  }
  function match(hash: number, remaining: number, tail: string): string | null {
    if (remaining === 0) {
      const firstHalf = firstHalves.get(hash);
      return firstHalf === undefined ? null : `${firstHalf}${tail}`;
    }
    for (const character of args.alphabet) {
      const found = match(
        reverseFnv1a(hash, character),
        remaining - 1,
        `${character}${tail}`,
      );
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  return match(target, args.rightLength, "");
}
