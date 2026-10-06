// Client-IP resolution for rate-limit buckets behind DeployKit's proxies.
//
// Topology: browsers reach the API through the web nginx
// (`proxy_pass http://api:3000`), so without proxy awareness every browser
// shares the socket peer address (the nginx container IP) and therefore one
// rate-limit bucket. nginx appends the true client IP to X-Forwarded-For
// (`$proxy_add_x_forwarded_for`), so the trustworthy entry is the LAST one:
// any earlier entries may be attacker-injected, and only our own proxy's
// appended entry can be believed — and only when the direct peer really is
// one of our proxies, i.e. a loopback/link-local/private address (docker
// bridge, compose network, localhost dev). Direct connections (including
// internet clients) use the socket address and ignore XFF entirely.
//
// Deliberately NOT `app.set('trust proxy')`: that would change req.ip
// globally for every route. This stays a local limiter decision with a
// single-hop model. Operators fronting DeployKit with a CDN/edge proxy
// should terminate there and let the edge's peer IP be the API's peer; the
// per-account email bucket still throttles targeted guessing regardless.

import net from "node:net";

function unwrapMapped(ip: string): string {
  const lower = ip.toLowerCase();
  return lower.startsWith("::ffff:") ? lower.slice("::ffff:".length) : lower;
}

export function isTrustedProxyPeer(address: string | undefined): boolean {
  if (!address) return false;
  const ip = unwrapMapped(address.trim());
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 127 || // loopback (local dev, vite proxy)
      a === 10 || // RFC1918 (docker default, compose)
      (a === 172 && b >= 16 && b <= 31) || // RFC1918 (docker bridge)
      (a === 192 && b === 168) || // RFC1918
      (a === 169 && b === 254) // link-local
    );
  }
  if (net.isIPv6(ip)) {
    if (ip === "::1") return true; // loopback
    const first = ip.split(":")[0] ?? "";
    const n = Number.parseInt(first || "0", 16);
    if (Number.isSafeInteger(n) && (n & 0xffc0) === 0xfe80) return true; // fe80::/10
  }
  return false;
}

function lastValidForwardedEntry(forwardedFor: string): string | null {
  const valid = forwardedFor
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && net.isIP(s) !== 0);
  return valid.length > 0 ? valid[valid.length - 1] : null;
}

// Pure and unit-testable: callers pass the socket peer and the raw header.
export function resolveClientIp(input: {
  socketAddress: string | undefined;
  forwardedFor: string | string[] | undefined;
}): string {
  const socket = (input.socketAddress ?? "").trim() || "unknown";
  if (!isTrustedProxyPeer(input.socketAddress)) {
    return socket;
  }
  const header = Array.isArray(input.forwardedFor)
    ? input.forwardedFor.join(",")
    : (input.forwardedFor ?? "");
  return lastValidForwardedEntry(header) ?? socket;
}
