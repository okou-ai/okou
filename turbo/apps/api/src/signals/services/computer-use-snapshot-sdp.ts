import { isIP } from "node:net";
import { hostPolicyIpLiteralIsPublic } from "@okouai/connectors/firewall-types";

function publicCandidates(lines: readonly string[], onlyRelay: boolean) {
  const candidates: string[] = [];
  for (const line of lines) {
    const match =
      /^a=candidate:([\w+/.-]{1,64}) 1 udp (\d{1,10}) ([0-9a-f.:]+) (\d{1,5}) typ (host|srflx|prflx|relay)(?: |$)/i.exec(
        line,
      );
    if (!match) {
      continue;
    }
    const [, foundation, priority, address, rawPort, type] = match;
    if (
      !address ||
      !rawPort ||
      !priority ||
      +rawPort < 1024 ||
      +rawPort > 65_535 ||
      +priority > 0xff_ff_ff_ff ||
      (onlyRelay && type !== "relay")
    ) {
      continue;
    }
    const family = isIP(address);
    if (
      !family ||
      !hostPolicyIpLiteralIsPublic(family === 6 ? "[" + address + "]" : address)
    ) {
      continue;
    }
    const related = type === "host" ? "" : " raddr 0.0.0.0 rport 0";
    candidates.push(
      "a=candidate:" +
        foundation +
        " 1 udp " +
        priority +
        " " +
        address +
        " " +
        rawPort +
        " typ " +
        type +
        related,
    );
    if (candidates.length === 24) {
      break;
    }
  }
  return candidates;
}

// The Guest controls its SDP. Only forward a single DTLS data channel and literal
// public UDP endpoints. In particular do not forward media, DNS, related/private
// addresses, or arbitrary connection/bandwidth/ICE attributes to the Mac.
export function snapshotDataDescription(
  sdp: string,
  role: "sender" | "receiver",
  relayOnly: boolean,
): string | null {
  const lines = sdp.trim().split(/\r?\n/);
  const media = lines.filter((line) => {
    return line.startsWith("m=");
  });
  if (
    media.length !== 1 ||
    !/^m=application \d{1,5} UDP\/DTLS\/SCTP webrtc-datachannel$/i.test(
      media[0] ?? "",
    )
  ) {
    return null;
  }
  const field = (name: string, pattern: RegExp) => {
    const matches = lines.filter((line) => {
      return line.startsWith(name);
    });
    const value = matches[0]?.slice(name.length);
    return matches.length === 1 && value && pattern.test(value) ? value : null;
  };
  const mid = field("a=mid:", /^[\w-]{1,32}$/);
  const ufrag = field("a=ice-ufrag:", /^[\w+/=-]{4,256}$/);
  const pwd = field("a=ice-pwd:", /^[\w+/=-]{22,256}$/);
  const fingerprint = field(
    "a=fingerprint:",
    /^sha-256 (?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/i,
  );
  const setup = field(
    "a=setup:",
    role === "sender" ? /^actpass$/ : /^(active|passive)$/,
  );
  const port = field("a=sctp-port:", /^\d{1,5}$/);
  if (
    !mid ||
    !ufrag ||
    !pwd ||
    !fingerprint ||
    !setup ||
    !port ||
    +port < 1 ||
    +port > 65_535
  ) {
    return null;
  }

  return [
    "v=0",
    "o=- 1 1 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE " + mid,
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=mid:" + mid,
    "a=ice-ufrag:" + ufrag,
    "a=ice-pwd:" + pwd,
    "a=fingerprint:" + fingerprint,
    "a=setup:" + setup,
    "a=sctp-port:" + port,
    "a=max-message-size:65536",
    ...publicCandidates(lines, role === "sender" && relayOnly),
    "a=end-of-candidates",
    "",
  ].join("\r\n");
}
