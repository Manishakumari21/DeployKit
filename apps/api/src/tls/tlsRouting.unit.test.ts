// Phase 11.9: HTTPS rendering policy (no DB, no docker).
// Policy under test:
// - valid TLS entry → HTTP redirects to HTTPS + 443 block serves the app.
// - no/expired/failed TLS → HTTP proxies, no redirect, no 443 block.
// - ACME challenge path always serves files on port 80, never redirects.
// - unverified or removed domains never become HTTPS routes.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProjectDomains,
  renderProjectRoute,
  sanitizeTlsEntries,
} from "../infrastructure/gateway/nginxGatewayRouter.js";
import { TrafficRouterError } from "../infrastructure/gateway/trafficRouter.js";

const PROJECT = "12345678-1234-1234-1234-123456789abc";
const RELEASE = "abcdefab-abcd-abcd-abcd-abcdefabcdef";

function target() {
  return {
    projectId: PROJECT,
    releaseId: RELEASE,
    containerName: "dk-p12345678-dabcdefab",
    containerIp: "172.20.0.5",
    containerPort: 3000,
  };
}

function tlsEntry(domain: string) {
  return {
    domain,
    certificateFile: `/etc/nginx/certs/domains/${domain}/fullchain.pem`,
    keyFile: `/etc/nginx/certs/domains/${domain}/private-key.pem`,
  };
}

test("valid certificate renders redirect plus terminating HTTPS block", () => {
  const content = renderProjectRoute(
    target(),
    ["tls.example.com", "plain.example.com"],
    [tlsEntry("tls.example.com")],
    "/tmp/challenges"
  );
  // Redirecting block covers only the TLS name.
  assert.match(content, /server_name tls\.example\.com;/);
  // The redirect must sit inside `location /`: a server-level `return`
  // would run before location selection and shadow the ACME location.
  assert.match(content, /location \/ \{\s+return 301 https:\/\/\$host\$request_uri;\s+\}/);
  // Application block keeps the derived host and the plain domain.
  assert.match(
    content,
    /server_name dk-p12345678\.deploykit\.local plain\.example\.com;/
  );
  // HTTPS block terminates with the deterministic paths.
  assert.match(content, /listen 443 ssl;/);
  assert.match(
    content,
    /ssl_certificate \/etc\/nginx\/certs\/domains\/tls\.example\.com\/fullchain\.pem;/
  );
  assert.match(
    content,
    /ssl_certificate_key \/etc\/nginx\/certs\/domains\/tls\.example\.com\/private-key\.pem;/
  );
  assert.match(content, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  // Challenge bypass exists in every port-80 block and never redirects.
  const challengeBlocks = content.match(/acme-challenge/g) ?? [];
  assert.ok(challengeBlocks.length >= 2);
  assert.match(content, /root \/tmp\/challenges;/);
  assert.match(content, /try_files \$uri =404;/);
  const names = parseProjectDomains(content);
  assert.ok(names.includes("tls.example.com"));
  assert.ok(names.includes("plain.example.com"));
});

test("no certificate means plain HTTP with no redirect and no 443", () => {
  const content = renderProjectRoute(target(), ["plain.example.com"]);
  assert.ok(!content.includes("listen 443"));
  assert.ok(!content.includes("ssl_certificate"));
  assert.ok(!content.includes("return 301"));
  assert.match(content, /proxy_pass http:\/\/dk_p12345678;/);
});

test("TLS entries for unverified domains are dropped, never routed", () => {
  const content = renderProjectRoute(target(), ["ok.example.com"], [
    tlsEntry("evil.example.com"),
  ]);
  assert.ok(!content.includes("evil.example.com"));
  assert.ok(!content.includes("listen 443"));
  assert.ok(content.includes("ok.example.com"));
});

test("invalid TLS entries are rejected before reaching nginx", () => {
  for (const bad of [
    [{ domain: "ok.example.com", certificateFile: "relative.pem", keyFile: "/x/key.pem" }],
    [{ domain: "ok.example.com", certificateFile: "/x/../y.pem", keyFile: "/x/key.pem" }],
    [{ domain: "ok.example.com", certificateFile: "/x/cert.crt", keyFile: "/x/key.pem" }],
    [{ domain: "ok.example.com", certificateFile: "/x/cert.pem", keyFile: "/x/key.pem\nevil" }],
    [{ domain: "localhost", certificateFile: "/x/cert.pem", keyFile: "/x/key.pem" }],
    [{ domain: "ok.example.com", certificateFile: "/x/cert.pem", keyFile: 42 }],
  ]) {
    assert.throws(() => sanitizeTlsEntries(bad), (e: unknown) => {
      return e instanceof TrafficRouterError;
    });
  }
  assert.deepEqual(sanitizeTlsEntries([]), []);
});
