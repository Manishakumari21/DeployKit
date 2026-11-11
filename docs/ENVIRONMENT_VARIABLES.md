# DeployKit — Environment Variables Reference

Exhaustive configuration reference for DeployKit control plane, workers, and edge agents.

---

## 1. Core & Database Configuration

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | `string` | `development` | Runtime mode (`production` or `development`). Strict security checks fail closed in production. |
| `PORT` | `number` | `3000` | Port for the API Express HTTP listener. |
| `DATABASE_URL` | `string` | *(Required)* | Full PostgreSQL connection URI: `postgresql://user:pass@host:port/dbname`. |
| `POSTGRES_USER` | `string` | `deploykit` | Database username used by Compose service. |
| `POSTGRES_PASSWORD` | `string` | *(Required)* | Database password. Generated automatically by installer. |
| `POSTGRES_DB` | `string` | `deploykit` | Primary database name. |

---

## 2. Security & Authentication

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `DEPLOYKIT_TOKEN_PEPPER` | `string` | *(Required in prod)* | 64-char hex string used to HMAC-SHA-256 hash sessions and agent tokens. Must remain constant across restarts. |
| `DEPLOYKIT_WEB_ORIGIN` | `string` | *(Required in prod)* | Comma-separated list of allowed frontend origins for CORS and CSRF verification. |
| `DEPLOYKIT_API_ORIGIN` | `string` | *(Derived)* | Public origin for API webhooks and callbacks. Defaults to `DEPLOYKIT_WEB_ORIGIN`. |
| `DEPLOYKIT_SESSION_DAYS` | `number` | `7` | Duration in days for browser session token validity. |
| `DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION` | `boolean` | `false` | When `false`, only the first user registers as admin; subsequent users must be invited. |
| `DEPLOYKIT_INVITE_DAYS` | `number` | `7` | Days an admin invite link remains valid before expiring. |
| `DEPLOYKIT_AUTH_RATE_LIMIT_WINDOW_SECONDS` | `number` | `900` | Sliding window (in seconds) for IP-based authentication rate limiting. |
| `DEPLOYKIT_AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `number` | `30` | Maximum login failures per IP within the window before temporary throttle. |

---

## 3. Worker, Build & Execution Engine

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `DEPLOYMENT_WORKER_ENABLED` | `boolean` | `true` | Enables the internal background deployment worker process. |
| `DEPLOYKIT_WORKER_CONCURRENCY` | `number` | `2` | Number of simultaneous container builds allowed on the host. |
| `WORKER_POLL_INTERVAL_MS` | `number` | `2000` | Frequency in ms for the worker to poll the PostgreSQL job queue. |
| `WORKER_LEASE_MS` | `number` | `30000` | Job lease duration. Workers heartbeat to renew their active lease. |
| `DEPLOYKIT_BUILDER_NAME` | `string` | `deploykit-builder` | Docker Buildx builder instance name. |
| `DEPLOYKIT_RUNTIME_NETWORK` | `string` | `deploykit-runtime` | Docker network where project runtime containers attach. |
| `DEPLOYKIT_ALLOWED_GIT_HOSTS` | `string` | `github.com` | Whitelist of permitted git host domains for cloning repositories. |

---

## 4. Internal OCI Registry & Garbage Collection

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `DEPLOYKIT_REGISTRY_HOST` | `string` | `deploykit-registry-tls:443` | Hostname and port for the internal OCI container registry. |
| `DEPLOYKIT_REGISTRY_NAMESPACE` | `string` | `deploykit` | Namespace prefix for built container images. |
| `DEPLOYKIT_REGISTRY_INSECURE` | `boolean` | `false` | When `true`, allows plain HTTP registry. **Prohibited in production.** |
| `DEPLOYKIT_REGISTRY_USERNAME` | `string` | `deploykit` | Optional basic auth username for registry pushes/pulls. |
| `DEPLOYKIT_REGISTRY_PASSWORD` | `string` | *(Empty)* | Basic auth password for registry. |
| `DEPLOYKIT_REGISTRY_GC_ENABLED` | `boolean` | `true` | Automatically cleans up untagged / unreferenced images. |
| `DEPLOYKIT_REGISTRY_DISK_SOFT_PERCENT` | `number` | `85` | Disk utilization threshold triggering image garbage collection sweep. |
| `DEPLOYKIT_REGISTRY_DISK_HARD_PERCENT` | `number` | `95` | Critical disk utilization threshold triggering aggressive pruning. |
| `DEPLOYKIT_REGISTRY_GC_KEEP_RELEASES` | `number` | `20` | Number of historical release images preserved during GC sweeps. |

---

## 5. Custom Domains & ACME TLS Certificates

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `DEPLOYKIT_TLS_MODE` | `string` | `acme` | Certificate provider: `acme` (Let's Encrypt / Lego) or `self-signed` (dev only). |
| `DEPLOYKIT_ACME_EMAIL` | `string` | *(Required for prod)* | Email address registered with ACME CA for certificate renewal notifications. |
| `DEPLOYKIT_ACME_SERVER` | `string` | *(Staging URL)* | ACME directory endpoint. Defaults to Let's Encrypt Staging; change to prod for valid certs. |
| `DEPLOYKIT_CERTS_DIR` | `string` | `/certs` | Path inside container where issued TLS certificates and keys are written. |
| `DEPLOYKIT_CERT_POLL_INTERVAL_MS` | `number` | `60000` | Frequency in ms for the certificate maintenance sweep. |

---

## 6. GitHub App Integration (Optional)

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `GITHUB_APP_ID` | `string` | *(Empty)* | Numeric GitHub App ID. |
| `GITHUB_APP_PRIVATE_KEY` | `string` | *(Empty)* | RSA Private Key in PEM format (or Base64 in `GITHUB_APP_PRIVATE_KEY_BASE64`). |
| `GITHUB_WEBHOOK_SECRET` | `string` | *(Empty)* | HMAC secret for verifying GitHub webhook deliveries (`X-Hub-Signature-256`). |
| `GITHUB_API_BASE_URL` | `string` | `https://api.github.com` | Base URL for GitHub REST API calls (allows GitHub Enterprise). |

---

## 7. Edge Agent Configuration

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `DEPLOYKIT_CONTROL_PLANE_URL` | `string` | *(Required)* | Base HTTPS URL of the central DeployKit control plane API. |
| `DEPLOYKIT_AGENT_TOKEN` | `string` | *(Required)* | 32-byte cryptographic token issued via the Servers dashboard. |
| `DEPLOYKIT_AGENT_ID` | `string` | *(Optional)* | UUID of the enrolled agent to lock identity fail-closed. |
| `DEPLOYKIT_EDGE_POLL_INTERVAL_MS` | `number` | `5000` | Frequency in ms for checking new deployment releases. |
| `DEPLOYKIT_EDGE_ALLOW_HTTP` | `boolean` | `false` | Set `true` only for local test environments. |
