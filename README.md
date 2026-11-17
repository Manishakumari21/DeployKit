# DeployKit — Production-Grade Self-Hosted PaaS

> **Your infrastructure. Your deployments. Your control.**
> A reliable, secure, production-grade alternative to Vercel, Render, and Railway that installs on any Linux VPS or bare metal with zero vendor lock-in.

[![Backend Tests](https://img.shields.io/badge/backend%20tests-804%20passed-2ea44f?style=flat-square)](docs/PRODUCTION_ACCEPTANCE_REPORT.md)
[![Frontend Tests](https://img.shields.io/badge/frontend%20tests-119%20passed-2ea44f?style=flat-square)](docs/PRODUCTION_ACCEPTANCE_REPORT.md)
[![Total Tests](https://img.shields.io/badge/total%20tests-923%20passed-2ea44f?style=flat-square)](docs/PRODUCTION_ACCEPTANCE_REPORT.md)
[![Database Migrations](https://img.shields.io/badge/migrations-24%20reconciled-blue?style=flat-square)](database/migrations)
[![Architecture](https://img.shields.io/badge/architecture-Docker%20BuildKit%20%7C%20OpenResty%20%7C%20PostgreSQL-blueviolet?style=flat-square)](docs/ARCHITECTURE.md)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

---

## 1. Executive Summary & Philosophy

Modern cloud PaaS platforms like Vercel, Render, and Railway offer great developer ergonomics, but they charge steep markups on basic compute, impose per-seat pricing, lock your infrastructure into proprietary clouds, and leave developers stranded with cryptic runtime errors.

**DeployKit** gives you the push-to-deploy developer experience of modern cloud platforms on your own hardware or Linux VPS:
* **$0 PaaS Markup:** Run unlimited applications on a $5–$20/mo VPS (Hetzner, DigitalOcean, Linode, AWS EC2, or bare metal).
* **100% Data Sovereignty:** Your source code, customer databases, and AES-256-GCM encrypted secrets live strictly on your servers.
* **Built-in Smart Error Doctor:** Automatic root cause detection and 1-click copy-paste code fixes for Docker networking traps, missing start commands, and OOM crashes.
* **Enterprise Safety:** Multi-stage Docker BuildKit compilation, immutable OCI image digest pinning, atomic OpenResty reverse-proxy reloads, and zero-downtime rollouts.
* **Distributed Edge Nodes:** Turn any secondary VPS or on-premise bare metal into an edge worker node in seconds with `deploykit-agent`.

---

## 2. Platform Comparison Matrix

| Feature | DeployKit (Self-Hosted) | Vercel | Render | Railway | Coolify |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Hosting Cost** | **$0 PaaS markup** (flat VPS rate $5–$20/mo) | Tiered compute + $20/seat/mo + bandwidth | Tiered compute + egress markups | Usage execution + resource markup | $0 PaaS markup |
| **Beginner Error Diagnosis** | **Built-in Smart Error Doctor** (plain English + 1-click code fixes) | Cryptic error codes (`FUNCTION_INVOCATION_FAILED`) | Raw terminal logs | Raw container logs | Raw terminal logs |
| **Data & Secret Privacy** | **100% on your server** (AES-256-GCM encrypted) | Proprietary cloud storage | Cloud infrastructure | Cloud infrastructure | Stored on host |
| **Team Members** | **Unlimited free** (Role-Based Access Control) | $20/user/mo on Pro tier | Paid organization seats | Team seat add-on fees | Unlimited free |
| **Distributed Edge Nodes** | **Included** (`deploykit-agent` connects any VPS) | Enterprise edge only | Single cloud region | Cloud regions only | Multiple servers |
| **Polyglot Auto-Detection** | **Static, Vite/React, Node, Python, Rust, Go, Docker** | Frontend & Serverless focus | Standard buildpacks | Nixpacks & Docker | Nixpacks & Docker |
| **Zero-Downtime Rollouts** | **Atomic OpenResty reload + health verification** | Automated | Automated | Automated | Container restart |
| **Database & Backups** | **Self-hosted PostgreSQL + non-blocking pg_dump** | Add-on integrations | Managed add-on ($7+/mo) | Managed add-on | Self-hosted add-on |

---

## 3. 🩺 Built-in Smart Error Doctor

Deploying applications should not require deciphering opaque container crash logs. DeployKit features an in-dashboard **Smart Error Doctor** that analyzes build outputs and runtime diagnostics to provide plain-English explanations and instant copy-paste code fixes:

* **The Docker `127.0.0.1` vs `0.0.0.0` Binding Trap:** Explains why binding a web server to `localhost` fails inside an isolated container, and provides instant 1-line configuration fixes:
  * **Node.js / Express:** `app.listen(PORT, '0.0.0.0', ...)`
  * **Next.js:** `HOSTNAME=0.0.0.0 next start`
  * **FastAPI / Python:** `uvicorn.run(app, host="0.0.0.0", port=PORT)`
* **Missing Start Script Detection:** Identifies missing npm `"start"` commands or misconfigured binary entrypoints before container startup fails.
* **OOM (Out Of Memory) Detection:** Detects Linux kernel exit code `137` and advises on container memory threshold adjustments.
* **1-Click Remediation:** Direct action buttons jump straight to Settings, inspect raw logs, or retry deployment.

---

## 4. Quickstart (One-Line Automated Installation)

DeployKit installs on **Ubuntu 22.04 / 24.04, Debian 12**, or any modern Linux VPS:

```bash
git clone https://github.com/Manishakumari21/DeployKit.git /opt/deploykit
cd /opt/deploykit
./install.sh
```

The installer verifies Docker and required ports, generates high-entropy cryptographic secrets, initializes PostgreSQL, reconciles all 24 schema migrations, launches the containerized stack, and outputs your Web Console URL (`http://<SERVER_IP>:8081` or `http://localhost:5173`).

### Local Development Stack

To run DeployKit locally with live reloading:

```bash
# 1. Start core database and registry services
docker compose up -d

# 2. Start the API backend
cd apps/api && npm install && npm run build
PORT=3000 npm start

# 3. Start the Web console
cd apps/web && npm install && npm run dev
```

Visit the dashboard at `http://localhost:5173` (or `http://localhost:8083`).

---

## 5. System Architecture & 5-Step Pipeline Flow

DeployKit decouples the Web UI, API control plane, durable database queue, worker daemon, and edge execution nodes:

```
                  ┌──────────────────────────────────────────────┐
                  │                 DeployKit Web                │
                  │   Vite React SPA · Smart Error Doctor        │
                  └──────────────────────┬───────────────────────┘
                                         │ HTTPS / Session Cookie
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │                 DeployKit API                │
                  │  Fastify REST · RBAC Auth · AES-256 Secrets   │
                  └──────────────────────┬───────────────────────┘
                                         │ Durable Job Insert
                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        PostgreSQL 18 Database Engine                                   │
│   • deployments & releases audit history                                               │
│   • advisory-locked queue (SELECT FOR UPDATE SKIP LOCKED)                              │
│   • AES-256-GCM encrypted project environment variables                               │
└────────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │ Claim via Fenced Lease
                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        DeployKit Worker Daemon                                         │
│   1. Git Checkout  ──► Isolated sandboxed clone of repository SHA                      │
│   2. Stack Detect  ──► Polyglot detection (Node, Python, Go, Rust, Static)             │
│   3. BuildKit      ──► Multi-stage compilation & immutable OCI digest generation       │
│   4. Registry      ──► Push to local/TLS registry (deploykit-registry:5000)            │
│   5. Gateway Route ──► Spawn container, HTTP health probe, atomic OpenResty reload     │
└────────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │ Dynamic Route Generation
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │            OpenResty Gateway (Nginx)         │
                  │  Zero-Downtime Blue/Green · Automated ACME   │
                  └──────────────────────────────────────────────┘
```

---

## 6. Multi-Stack Polyglot Engine & Detection Matrix

DeployKit's smart build engine inspects the root of your repository, identifies the framework, and automatically generates an unprivileged, multi-stage production container with zero configuration:

| Language / Framework | Markers Detected | Default Port | Container Base | Build Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **Static HTML / CSS / JS** | `index.html` | `8080` | `nginxinc/nginx-unprivileged:alpine` | Direct static asset copy into unprivileged Nginx |
| **React / Vite / Vue** | `package.json`, `vite.config.*` | `8080` | `node:20-alpine` → `nginx:alpine` | Multi-stage: `npm run build` → serve `dist/` via Nginx |
| **Node.js / Express** | `package.json` | `3000` | `node:20-alpine` | `npm ci` → run start script as non-root `appuser` |
| **Python / FastAPI / Flask** | `pyproject.toml`, `requirements.txt` | `8000` | `python:3.11-slim` | Virtualenv dependency isolation, Uvicorn/Gunicorn runner |
| **Rust / Axum / Actix** | `Cargo.toml` | `8080` | `rust:alpine` → `alpine:3.19` | Multi-stage release compilation with Musl libc |
| **Go / Gin / Fiber** | `go.mod` | `8080` | `golang:1.22-alpine` → `alpine:3.19` | `CGO_ENABLED=0` static binary compilation |
| **Custom Dockerfile** | `Dockerfile` | Custom | Defined by user | Docker BuildKit multi-stage execution |

---

## 7. Zero-Downtime Releases & Instant 1-Click Rollback

* **Atomic Blue/Green Cutover:** When a new release container launches beside an active one, it must pass HTTP health verification (`2xx`/`3xx`). Only then does PostgreSQL atomically mark it `active` under a project advisory lock and reload the OpenResty gateway (`nginx -s reload`). Connections drain gracefully with zero dropped packets.
* **Immutable OCI Digest Pinning:** Releases are identified strictly by `repository@sha256:<digest>`. Mutable tags (`latest`) are never used as deployment identity.
* **Instant Rollbacks Without Rebuilding:** Rolling back to any previous release reuses the stored OCI digest directly, launching the proven container in seconds without re-compiling.

---

## 8. Distributed Edge Infrastructure (`deploykit-agent`)

Turn secondary VPS servers, home lab machines, or bare metal into distributed execution nodes:

1. Enroll an edge agent node:
   ```bash
   npm run --prefix apps/api agent:enroll -- --name "hetzner-edge-01"
   ```
2. Run the lightweight agent on the remote machine:
   ```bash
   DEPLOYKIT_AGENT_TOKEN="<ENROLLMENT_TOKEN>" node dist/edgeAgent.js
   ```
3. Target deployments to specific edge nodes directly from the Web Console or API.

---

## 9. Security Architecture & Zero-Trust Hardening

DeployKit is built with defense-in-depth security principles:
* **AES-256-GCM Secret Encryption:** All environment variables and API keys are encrypted at rest using envelope encryption with per-secret cryptographic initialization vectors (IVs).
* **Zero Host Socket Exposure:** The Docker socket (`/var/run/docker.sock`) is mounted **strictly into the isolated background worker daemon**. Neither the Web frontend nor the Fastify API has access to the Docker socket.
* **Least-Privilege Runtimes:** Generated containers run as non-root `USER 10001`, with `read-only` root filesystems, `cap-drop ALL`, and `no-new-privileges` enabled.
* **Strict Session Security:** HttpOnly, SameSite=Lax cookies with SHA-256 session token hashing, IP-based fixed-window rate limiting, and strict CSRF Origin verification.

---

## 10. Complete REST API Specification

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Sign in with email and password | Public |
| `POST` | `/api/auth/register` | Register initial admin or redeem invite | Public / Invite |
| `GET` | `/api/auth/session` | Get current authenticated user session | Session Cookie |
| `GET` | `/api/projects` | List all projects owned by the user | Session Cookie |
| `POST` | `/api/projects` | Create a new project (Git URL, branch) | Session Cookie |
| `DELETE` | `/api/projects/:id` | Delete a project and tear down containers | Session Cookie |
| `POST` | `/api/projects/:id/deployments` | Trigger an automated deployment flight | Session Cookie |
| `GET` | `/api/projects/:id/deployments` | List historical deployments for project | Session Cookie |
| `POST` | `/api/deployments/:id/cancel` | Cancel an in-flight deployment | Session Cookie |
| `GET` | `/api/deployments/:id/logs` | Fetch cursor-paginated deployment logs | Session Cookie |
| `POST` | `/api/projects/:id/rollback` | 1-click rollback to a specific release | Session Cookie |
| `GET` | `/api/projects/:id/env` | Retrieve decrypted environment variables | Session Cookie |
| `PUT` | `/api/projects/:id/env` | Store encrypted environment variables | Session Cookie |
| `GET` | `/api/health` | Service health check status | Public |

---

## 11. Database Migrations & Disaster Recovery Runbook

### Schema Migrations
All 24 database migrations (`database/migrations/*.sql`) are applied in deterministic lexical order with session-scoped advisory locks:

```bash
cd apps/api
DATABASE_URL=postgresql://deploykit:deploykit@localhost:5432/deploykit npm run db:migrate
```

### Automated Backup & Restore
Automated scripts provide safe, non-blocking backups:

```bash
# Take a compressed custom-format backup
cd ops/backup && ./backup-db.sh

# Verify and test restore in an isolated scratch database
./restore-db.sh backups/deploykit-<timestamp>.dump

# Live restoration (requires explicit confirmation)
./restore-db.sh --force-live backups/deploykit-<timestamp>.dump
```

---

## 12. Production Verification & Test Audit

DeployKit includes an automated test gate that guarantees 100% test pass fidelity across all database and unit suites:

* **Backend Unit & DB Suites:** **804 passed, 0 failed** across all 40 database suites.
* **Frontend Unit Suites:** **119 passed, 0 failed** across all 14 test files.
* **Total Monorepo Tests:** **923 passed, 0 failed (100% pass rate)**.
* **Linting & Type Safety:** Clean compilation with 0 ESLint errors and 0 TypeScript warnings.

To run the complete test suite locally:

```bash
# Frontend tests
npm test --prefix apps/web

# Backend tests (with database gate verification)
npm test --prefix apps/api
```

---

## 13. Documentation Suite

- 🚀 **[Installation & VPS Setup Guide](docs/INSTALLATION.md)** — Step-by-step instructions, firewall rules, ports, and troubleshooting.
- 🏗️ **[System Architecture & Internals](docs/ARCHITECTURE.md)** — Deep dive into API, Worker, OpenResty Gateway, Edge Agent, and database design.
- ⚙️ **[Environment Variables Reference](docs/ENVIRONMENT_VARIABLES.md)** — Complete reference of every configuration key and production defaults.
- 🌐 **[Edge Servers & Distributed Execution](docs/EDGE_SERVERS.md)** — How to enroll remote server nodes and run hybrid multi-node deployments.
- 🛡️ **[Security Architecture & Hardening](docs/SECURITY.md)** — AES-256-GCM encryption, token peppers, Docker argv safety, and CSRF defense.
- 💾 **[Backup & Disaster Recovery Guide](docs/BACKUP_AND_RESTORE.md)** — Non-destructive database backup, verification, and live restore procedures.
- 📋 **[Production Acceptance Report](docs/PRODUCTION_ACCEPTANCE_REPORT.md)** — Verification results, test coverage, and sign-off audit.

---

## 14. License

Distributed under the **MIT License**. See `LICENSE` for details.
