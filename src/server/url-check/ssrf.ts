// SSRF guard for the pasted-job fetch path (spec 2026-07-12 §7). The
// denylist is checked against the RESOLVED address, never the host string —
// decimal/octal/hex IP literals in a URL normalize away during DNS
// resolution, so checking post-lookup is the only correct point.
//
// Residual risk: this is a check-then-connect gap — a DNS answer can rebind
// between our lookup here and undici's own connect in fetch-page.ts. Closing
// that needs a custom undici Agent whose connect hook re-validates
// `socket.remoteAddress` per connection.
// DISPOSITION (pre-launch hardening 2026-07-17, tracked risk 1): explicitly
// ACCEPTED for the invite-only friends launch — exploiting the rebind window
// needs an authenticated user running a malicious DNS server, implausible at
// n≤20. The undici connect-hook re-validation GATES PUBLIC LAUNCH.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`SSRF guard blocked request: ${reason}`);
    this.name = "SsrfBlockedError";
    this.reason = reason;
  }
}

function isDeniedIpv4(ip: string): boolean {
  if (ip === "0.0.0.0") return true;
  const octets = ip.split(".").map(Number);
  const [a, b] = octets;
  if (a === 127) return true; // loopback 127/8
  if (a === 10) return true; // private 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

function firstHextet(ip: string): number {
  // A canonical (compressed) IPv6 literal that starts with "::" has a zero
  // leading group — irrelevant here since both ranges below require a
  // nonzero first hextet, so treating that case as 0 is correct.
  if (ip.startsWith("::")) return 0;
  const first = ip.slice(0, ip.indexOf(":"));
  return parseInt(first, 16);
}

function isDeniedIpv6(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isDeniedIpv4(mapped[1]);
  if (ip === "::1") return true;
  const first = firstHextet(ip);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

export function isDeniedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isDeniedIpv4(ip);
  if (family === 6) return isDeniedIpv6(ip);
  return true; // not a valid IP literal — fail closed
}

export async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`unsupported scheme "${url.protocol}"`);
  }
  const records = await lookup(url.hostname, { all: true });
  if (records.length === 0) {
    throw new SsrfBlockedError(`no DNS records for "${url.hostname}"`);
  }
  for (const record of records) {
    if (isDeniedIp(record.address)) {
      throw new SsrfBlockedError(`resolved address "${record.address}" is not publicly routable`);
    }
  }
}
