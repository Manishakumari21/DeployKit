# DeployKit — Security Architecture & Hardening

DeployKit is built with defense-in-depth principles across authentication, session handling, secrets encryption, container isolation, and operational auditing.

---

## 1. Secrets & Environment Variables Encryption

- **Algorithm**: Authenticated Encryption using **AES-256-GCM**.
- **Ciphertext Integrity**: Every stored secret includes a unique Initialization Vector (IV) and a 16-byte authentication tag (`authTag`).
- **Fail-Closed Decryption**: If decryption fails (e.g., tampered data or invalid encryption key), the deployment pipeline **aborts immediately** rather than deploying containers with missing or partial secrets.
- **Masking on Delivery**: Secret variables are masked in all API responses (`••••••••`) unless explicitly revealed by an authenticated project owner via `GET /api/projects/:id/env-vars/:varId/reveal`.
- **Command-Line Defense**: Environment variables injected into Docker containers are passed via `--env KEY` with values provided in the process environment rather than `--env KEY=VALUE` on the command-line argument list. This prevents secrets from leaking via host `ps aux`, `/proc/<pid>/cmdline`, or host process monitors.

---

## 2. Authentication & Session Security

- **Cryptographic Token Pepper**: Session tokens, edge agent credentials, and invite tokens are hashed using `HMAC-SHA-256` keyed by `DEPLOYKIT_TOKEN_PEPPER`. Even in the event of an unauthorized database dump, tokens cannot be cracked or replayed offline.
- **Production Boot Guard**: In `NODE_ENV=production`, the API refuses to start if `DEPLOYKIT_TOKEN_PEPPER` is unset.
- **Secure Cookies**: Session cookies are configured with `HttpOnly`, `SameSite=Lax`, and `Secure` (enforced when `NODE_ENV=production` or `DEPLOYKIT_COOKIE_SECURE=true`).
- **CSRF & Origin Validation**: Unsafe state-mutating browser requests (`POST`, `PUT`, `DELETE`, `PATCH`) validate the `Origin` and `Referer` headers against `DEPLOYKIT_WEB_ORIGIN`. Unmatched origins are rejected with `403 Forbidden`.
- **Brute Force Protection**: IP-based and email-based rate limiters protect the login endpoint using sliding window buckets.

---

## 3. Container Isolation & Sandboxing

Runtime application containers are executed with restricted capabilities:
- **CPU & Memory Limits**: Default resource limits (e.g. `512MB RAM`, `1 vCPU`) prevent noisy neighbors or runaway processes from starving the host.
- **Bridge Network Segregation**: Containers run inside dedicated bridge networks (`deploykit-runtime`) isolated from the host network and the management database.
- **Docker Socket Protection**: Only the worker daemon mounts `/var/run/docker.sock`. Application workloads do not have access to the host daemon.

---

## 4. Git & Webhook Verification

- **HMAC Delivery Signatures**: Incoming GitHub webhooks verify the `X-Hub-Signature-256` header using the configured `GITHUB_WEBHOOK_SECRET`.
- **Fork PR Defense**: Pull request preview deployments ignore fork heads by default to prevent arbitrary code execution from untrusted third-party pull requests.
- **Git URL Sanitization**: Only valid HTTPS repository URLs from permitted git hosts (`DEPLOYKIT_ALLOWED_GIT_HOSTS`) are accepted. Embedded credentials or shell injection characters in repository URLs are rejected fail-closed.

---

## 5. Security Incident Response & Audit Trails

- All security-relevant events (failed logins, revoked agent credentials, TLS renewals, lease recoveries) generate structured, machine-readable audit logs.
- Sensitive credentials (passwords, bearer tokens, private keys) are automatically redacted from error messages and deployment logs before being written to disk or database.
