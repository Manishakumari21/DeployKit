

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
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (net.isIPv6(ip)) {
    if (ip === "::1") return true;
    const first = ip.split(":")[0] ?? "";
    const n = Number.parseInt(first || "0", 16);
    if (Number.isSafeInteger(n) && (n & 0xffc0) === 0xfe80) return true;
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
