import {
  KERBEROS_INPUT_MAX_BASE64,
  KERBEROS_INPUT_MAX_BYTES,
  kerberosPrincipalSchema,
  sameKerberosPrincipal,
  type KerberosPrincipal,
} from "./vnc-kerberos";

const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function invalid(): never {
  throw new Error("Invalid Kerberos credential");
}

/** Bounded structural validation only; no native execution, IO or authentication. */
class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining() {
    return this.bytes.length - this.offset;
  }
  take(size: number): Uint8Array {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.remaining) {
      invalid();
    }
    const result = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }
  number(size: 1 | 2 | 4, signed = false) {
    const bytes = this.take(size);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (size === 1) {
      return view.getUint8(0);
    }
    if (size === 2) {
      return view.getUint16(0);
    }
    return signed ? view.getInt32(0) : view.getUint32(0);
  }
  data(cap: number, short = false) {
    const size = this.number(short ? 2 : 4);
    if (size > cap) {
      invalid();
    }
    return this.take(size);
  }
  principal(keytab = false): KerberosPrincipal {
    if (!keytab && this.number(4) > 3) {
      invalid();
    }
    const count = this.number(keytab ? 2 : 4);
    if (count < 1 || count > 8) {
      invalid();
    }
    const realm = decoder.decode(this.data(255, keytab));
    const components: string[] = [];
    for (let index = 0; index < count; index++) {
      components.push(decoder.decode(this.data(255, keytab)));
    }
    if (keytab && this.number(4) > 3) {
      invalid();
    }
    const parsed = kerberosPrincipalSchema.safeParse({ realm, components });
    if (!parsed.success) {
      invalid();
    }
    return parsed.data;
  }
}

class Writer {
  private readonly bytes = new Uint8Array(KERBEROS_INPUT_MAX_BYTES);
  private offset = 0;
  put(value: Uint8Array) {
    if (value.length > this.bytes.length - this.offset) {
      invalid();
    }
    this.bytes.set(value, this.offset);
    this.offset += value.length;
  }
  number(value: number, size: 1 | 2 | 4) {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    if (size === 1) {
      view.setUint8(0, value);
    } else if (size === 2) {
      view.setUint16(0, value);
    } else {
      view.setUint32(0, value);
    }
    this.put(bytes);
  }
  data(value: Uint8Array, short = false) {
    this.number(value.length, short ? 2 : 4);
    this.put(value);
  }
  principal(value: KerberosPrincipal, kind: number, keytab = false) {
    if (!keytab) {
      this.number(kind, 4);
    }
    this.number(value.components.length, keytab ? 2 : 4);
    this.data(utf8.encode(value.realm), keytab);
    for (const component of value.components) {
      this.data(utf8.encode(component), keytab);
    }
    if (keytab) {
      this.number(kind, 4);
    }
  }
  finish() {
    const result = this.bytes.slice(0, this.offset);
    this.bytes.fill(0);
    return result;
  }
  clear() {
    this.bytes.fill(0);
  }
}

export function decodeKerberosMaterial(encoded: string): Uint8Array {
  if (encoded.length > KERBEROS_INPUT_MAX_BASE64) {
    invalid();
  }
  const decoded = atob(encoded);
  if (decoded.length > KERBEROS_INPUT_MAX_BYTES) {
    invalid();
  }
  const result = Uint8Array.from(decoded, (character) => {
    return character.charCodeAt(0);
  });
  if (encodeKerberosMaterial(result) !== encoded) {
    result.fill(0);
    invalid();
  }
  return result;
}

export function encodeKerberosMaterial(value: Uint8Array): string {
  if (value.length > KERBEROS_INPUT_MAX_BYTES) {
    invalid();
  }
  // A bounded loop avoids spreading a large untrusted input onto the JS stack.
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Consume a canonical upload while encoding, including on encoding failure. */
export function encodeAndClearKerberosMaterial(value: Uint8Array): string {
  try {
    return encodeKerberosMaterial(value);
  } finally {
    value.fill(0);
  }
}

function aes(enctype: number, key: Uint8Array) {
  if (!(
    (enctype === 17 && key.length === 16) ||
    (enctype === 18 && key.length === 32)
  )) {
    invalid();
  }
}

function items(reader: Reader) {
  const count = reader.number(4);
  if (count > 16) {
    invalid();
  }
  for (let index = 0; index < count; index++) {
    reader.number(2);
    reader.data(8192);
  }
  return count;
}

function readCacheHeader(reader: Reader, initiator: KerberosPrincipal) {
  if (reader.number(2) !== 0x0504) {
    invalid();
  }
  const header = new Reader(reader.data(1024, true));
  let fields = 0;
  while (header.remaining > 0) {
    if (++fields > 16) {
      invalid();
    }
    const tag = header.number(2);
    const size = header.number(2);
    if (tag === 1 && size !== 8) {
      invalid();
    }
    header.take(size);
  }
  if (!sameKerberosPrincipal(reader.principal(), initiator)) {
    invalid();
  }
}

function readCacheRecord(reader: Reader, initiator: KerberosPrincipal) {
  const client = reader.principal();
  const server = reader.principal();
  const enctype = reader.number(2);
  const key = reader.data(KERBEROS_INPUT_MAX_BYTES);
  const auth = reader.number(4);
  const start = reader.number(4);
  const end = reader.number(4);
  const renew = reader.number(4);
  const userUser = reader.number(1);
  if (userUser > 1 || !sameKerberosPrincipal(client, initiator)) {
    invalid();
  }
  const flags = reader.number(4);
  const addresses = items(reader);
  const authdata = items(reader);
  const ticket = reader.data(48 * 1024);
  const second = reader.data(48 * 1024);
  return {
    server,
    enctype,
    key,
    auth,
    start,
    end,
    renew,
    userUser,
    flags,
    addresses,
    authdata,
    ticket,
    second,
  };
}

function validateSelectedServiceRecord(
  record: ReturnType<typeof readCacheRecord>,
  expiry: number | null,
  now: number,
) {
  const {
    enctype,
    key,
    auth,
    start,
    end,
    renew,
    addresses,
    authdata,
    userUser,
    second,
    ticket,
  } = record;
  const effectiveStart = start === 0 ? auth : start;
  aes(enctype, key);
  if (
    expiry !== null ||
    addresses !== 0 ||
    authdata !== 0 ||
    userUser !== 0 ||
    second.length !== 0 ||
    ticket.length === 0 ||
    auth === 0 ||
    auth > effectiveStart ||
    effectiveStart >= end ||
    [auth, start, end, renew].some((value) => {
      return value > 0x7fff_ffff;
    }) ||
    (renew !== 0 && renew < end) ||
    now < effectiveStart ||
    now >= end
  ) {
    invalid();
  }
}

/** Consume/clear the input; return only one canonical selected service. */
export function canonicalKerberosTicket(
  input: Uint8Array,
  initiator: KerberosPrincipal,
  service: KerberosPrincipal,
  now: number,
): { bytes: Uint8Array; declaredExpiresAt: number } {
  const output = new Writer();
  try {
    if (
      input.length > KERBEROS_INPUT_MAX_BYTES ||
      service.realm !== initiator.realm ||
      service.components.length !== 2 ||
      service.components[0] !== "vnc" ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > 0xffff_ffff
    ) {
      invalid();
    }
    const reader = new Reader(input);
    readCacheHeader(reader, initiator);
    let count = 0;
    let expiry: number | null = null;
    while (reader.remaining > 0) {
      if (++count > 64) {
        invalid();
      }
      const record = readCacheRecord(reader, initiator);
      const { server, enctype, key, auth, start, end, renew, flags, ticket } =
        record;
      if (!sameKerberosPrincipal(server, service)) {
        continue;
      }
      validateSelectedServiceRecord(record, expiry, now);
      output.put(new Uint8Array([5, 4, 0, 0]));
      output.principal(initiator, 1);
      output.principal(initiator, 1);
      output.principal(service, 2);
      output.number(enctype, 2);
      output.data(key);
      for (const time of [auth, start, end, renew]) {
        output.number(time, 4);
      }
      output.number(0, 1);
      output.number(flags, 4);
      output.put(new Uint8Array(8));
      output.data(ticket);
      output.number(0, 4);
      expiry = end;
    }
    if (expiry === null) {
      invalid();
    }
    return { bytes: output.finish(), declaredExpiresAt: expiry };
  } finally {
    input.fill(0);
    output.clear();
  }
}

/** FILEkeytab2 canonicalization matches K1; mixed identities and keys refuse. */
export function canonicalKerberosKeytab(
  input: Uint8Array,
  initiator: KerberosPrincipal,
): Uint8Array {
  const output = new Writer();
  try {
    if (input.length > KERBEROS_INPUT_MAX_BYTES) {
      invalid();
    }
    const reader = new Reader(input);
    if (reader.number(2) !== 0x0502) {
      invalid();
    }
    const keys: { kvno: number; enctype: number; key: Uint8Array }[] = [];
    let count = 0;
    while (reader.remaining > 0) {
      if (++count > 64) {
        invalid();
      }
      const signed = reader.number(4, true);
      if (signed === 0) {
        if (reader.remaining !== 0) {
          invalid();
        }
        break;
      }
      const data = reader.take(Math.abs(signed));
      if (signed < 0) {
        if (
          data.some((value) => {
            return value !== 0;
          })
        ) {
          invalid();
        }
        continue;
      }
      if (keys.length >= 16) {
        invalid();
      }
      const entry = new Reader(data);
      if (!sameKerberosPrincipal(entry.principal(true), initiator)) {
        invalid();
      }
      entry.number(4);
      let kvno = entry.number(1);
      const enctype = entry.number(2);
      const key = entry.data(KERBEROS_INPUT_MAX_BYTES, true);
      aes(enctype, key);
      if (entry.remaining >= 4) {
        const wide = entry.number(4);
        if (wide !== 0) {
          kvno = wide;
        }
      }
      if (
        kvno === 0 ||
        keys.some((existing) => {
          return existing.kvno === kvno && existing.enctype === enctype;
        })
      ) {
        invalid();
      }
      keys.push({ kvno, enctype, key });
    }
    if (keys.length === 0) {
      invalid();
    }
    output.put(new Uint8Array([5, 2]));
    for (const key of keys.sort((left, right) => {
      return left.kvno - right.kvno || left.enctype - right.enctype;
    })) {
      const entry = new Writer();
      try {
        entry.principal(initiator, 1, true);
        entry.number(0, 4);
        entry.number(key.kvno & 255, 1);
        entry.number(key.enctype, 2);
        entry.data(key.key, true);
        entry.number(key.kvno, 4);
        const record = entry.finish();
        try {
          output.number(record.length, 4);
          output.put(record);
        } finally {
          record.fill(0);
        }
      } finally {
        entry.clear();
      }
    }
    return output.finish();
  } finally {
    input.fill(0);
    output.clear();
  }
}
