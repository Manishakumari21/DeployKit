# DeployKit — Production Completion Plan

**Document Version:** 1.0.0
**Date:** 2026-11-11
**Repository:** [https://github.com/Manishakumari21/DeployKit](https://github.com/Manishakumari21/DeployKit)
**Workspace:** `/home/manisha/deploykit`
**Target:** Production-Grade Self-Hosted PaaS Alternative to Vercel, Render, and Railway

---

## 1. Executive Summary & Architecture Overview

DeployKit is a modern, self-hosted Platform-as-a-Service (PaaS) engineered to give developers and teams complete infrastructure ownership, predictable infrastructure costs, and zero platform vendor lock-in.

### 1.1 Core Architecture Components

```
                                  +------------------------------------+
                                  |    GitHub / Git Remote Webhook     |
                                  +-----------------+------------------+
                                                    | (HMAC-SHA256 Push)
                                                    v
+------------------+   HTTPS / WSS    +--------------------------------+
|  Developer Web   | ---------------> |     OpenResty Gateway          |
|  Dashboard (SPA) | <--------------- |   (ops/gateway, ports 80/443)  |
+------------------+                  +-----------------+--------------+
                                                        |
                 +--------------------------------------+--------------------------------------+
                 | (Reverse Proxy to Internal Ports)                                           | (Reverse Proxy to API)
                 v                                                                             v
+------------------------------------+                                        +--------------------------------+
|    User Application Runtimes       |                                        |     DeployKit API Server       |
|  - Container: dk_p<shortId>        |                                        |   (apps/api, port 3000)        |
|  - Read-Only Root + Tmpfs          |                                        |   - Express 5.2 / TypeScript   |
|  - Network: deploykit-runtime      |                                        |   - Auth / Session Engine      |
+------------------------------------+                                        +-----------------+--------------+
                 ^                                                                              |
                 | (Docker run / start / stop)                                                  | (Enqueue Job / Leases)
                 |                                                                              v
+----------------+-------------------+     PostgreSQL Job Claim / State       +--------------------------------+
|  DeployKit Background Worker       | <====================================> |      PostgreSQL Database       |
|  (apps/api/src/workers/worker.ts)  |                                        |   (PostgreSQL 18, port 5432)   |
|  - Buildx Builder + Runtime Mgr    |                                        |   - 24 Schema Migrations       |
+-----------------+------------------+                                        +--------------------------------+
                  |
        +---------+---------+
        |                   |
        v                   v
+-------------------+   +--------------------+
|  Docker Buildx    |   |  Private Registry  |
|  (deploykit-      |   |  (registry:2.8.3,  |
|   builder daemon) |   |   port 5000 / TLS) |
+-------------------+   +--------------------+
```

---

## 2. Existing Implementation & Verified Capabilities

Through code inspection and test suite execution against PostgreSQL, the following components are verified as functional:

1. **Transactional Job Queue & Lease Fencing:**
   - PostgreSQL `FOR UPDATE SKIP LOCKED` prevents race conditions between worker instances.
   - Expiration-bounded leases (`lease_token`) prevent zombie workers from corrupting job state.
2. **BuildKit Buildx Compilation & Immutable OCI Digest Pinning:**
   - Isolated `deploykit-builder` container builds images.
   - Extracts `containerimage.digest` (`sha256:...`) directly from BuildKit metadata to ensure deployments run verifiable, immutable images.
3. **Zero-Downtime Blue/Green Release Switching:**
   - New containers start on high-range ports on `deploykit-runtime`.
   - Health probes (`/api/health` or `/`) must pass before OpenResty route reloads. Old containers stay active if probes fail.
4. **Tamper-Proof Rollback:**
   - Restores prior validated OCI image digest directly without re-cloning Git or re-executing build steps.
5. **Smart Dockerfile Synthesis (Added in recent session):**
   - Automatically detects and generates Dockerfiles for Node.js (Next.js, Vite, Express), Python, Rust, Go, and static SPAs.
6. **Environment Variable Security (Migration 024):**
   - Authenticated AES-256-GCM encryption at rest using keys derived via HKDF-SHA256 from `DEPLOYKIT_TOKEN_PEPPER`.
   - Masked secret values in standard API responses.
7. **GitHub Integration & Webhook Ingestion:**
   - Timing-safe HMAC-SHA256 signature verification (`X-Hub-Signature-256`).
   - Push and Pull Request webhook handlers with automated deployment triggers.
8. **Automated Testing Suite:**
   - 795 passing unit and database tests in `apps/api`.
   - 108 passing tests and clean TypeScript / Vite production build in `apps/web`.

---

## 3. Missing Implementation & Subsystem Gaps

1. **Remote Servers & Edge Agents UI and Management:**
   - Backend `agentService.ts` contains agent creation, credential issuance, rotation, and revocation, but there are no REST API endpoints for projects to list, enroll, or revoke agents.
   - The frontend lacks a "Servers & Agents" view for managing remote servers, inspecting connection status, and copying enrollment commands.
2. **Public Landing Page & Brand Differentiation:**
   - No public landing page exists; unauthenticated users are directed only to a bare login screen.
   - Needs a public marketing and documentation page communicating:
     - "DeployKit — Your infrastructure. Your deployments. Your control."
     - Factual comparison: DeployKit vs. Vercel vs. Render vs. Railway.
     - Architecture overview, supported tech, security model, and 1-line installation instructions.
3. **Dashboard Differentiation & Infrastructure Transparency:**
   - Missing explicit contextual indicators in the dashboard:
     - Server / host ownership indicator.
     - Release immutability verification badges (OCI SHA256).
     - Container isolation limits (CPU limit, RAM limit, read-only root status).
     - Transparent infrastructure cost visibility and estimated savings vs. managed clouds.
4. **Onboarding & First-Run Experience:**
   - First-time empty state is minimal and doesn't guide a new developer through the deployment journey.
   - Needs an interactive Welcome & Onboarding Checklist (Connect Git/GitHub -> Commission Project -> Review Build Config -> Configure Env Secrets -> Deploy & Verify).
5. **Secret Reveal for Authorized Users:**
   - Currently, secrets are permanently masked in the UI with no way for an authorized project owner to reveal a secret if needed.
   - Add explicit authorized reveal endpoint with project access verification.
6. **Docker Secret Exposure Hardening:**
   - Passing `--env KEY=VALUE` as command line arguments to `docker container create` risks exposing secrets in `ps aux` on the host. Pass env variables via temporary secure environment file or child process environment.
7. **Automated Linux Installer Script:**
   - Missing an automated, idempotent `ops/install.sh` / `install.sh` script for clean Ubuntu/Debian/Linux VPS installations that performs prerequisite checks (Docker, Compose, ports, curl), generates secure environment configurations, runs database initialization, and starts all services.

---

## 4. Prioritized Implementation Plan

| Phase | Focus Area | Key Actions |
|:---|:---|:---|
| **Phase 1** | Finish Functionality & APIs | Add Project Agent routes (`GET`, `POST`, `DELETE` `/api/projects/:id/agents`), secret reveal route, update migration reconcile script. |
| **Phase 2** | Security Hardening | Container environment variable injection hardening (prevent `ps` leakage), rate limits, CORS verification, audit logs. |
| **Phase 3** | Developer Onboarding | Interactive Welcome Checklist, actionable error states, deployment status indicators, helpful tooltips. |
| **Phase 4** | Differentiation & Landing Page | Responsive Public Landing Page with Hero, Feature Highlights, Factual PaaS Comparison, Architecture breakdown, Installation guide. |
| **Phase 5** | Dashboard UX Polish | "Servers & Agents" view, Infrastructure & Cost transparency badges, Immutability indicators, container limits display. |
| **Phase 6** | Performance & Optimization | Database query indexing review, bundle verification, build cache efficiency. |
| **Phase 7** | Installation & Operations | `install.sh` with prerequisite checks, automated `.env` generation with crypto random peppers, health verify. |
| **Phase 8** | Automated Testing | Comprehensive unit and integration test coverage for newly added routes, security guards, and frontend components. |
| **Phase 9** | Production Documentation | Complete guides: Installation, Quick-Start, Architecture, Environment Variables, GitHub, Backup & Restore, Security. |
| **Phase 10**| Acceptance & Reporting | Verification of all flows, building artifacts, generating `PRODUCTION_ACCEPTANCE_REPORT.md`. |

---

## 5. Completion Criteria

- [x] Full test suite running and passing across both backend and frontend.
- [ ] Agent & server management accessible through API and UI.
- [ ] Secret reveal supported securely with access control.
- [ ] Public landing page live with factual comparison table and clear call-to-actions.
- [ ] Dashboard displays server ownership, immutable release digests, resource limits, and cost transparency.
- [ ] First-run onboarding experience implemented.
- [ ] Production installer script `ops/install.sh` ready and verified.
- [ ] Complete documentation suite updated in `docs/` and `README.md`.
- [ ] Final `docs/PRODUCTION_ACCEPTANCE_REPORT.md` generated.
