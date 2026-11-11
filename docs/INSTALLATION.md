# DeployKit — Production Installation Guide

DeployKit is a modern, self-hosted Platform-as-a-Service (PaaS) designed to run on any Linux VPS or dedicated server (Ubuntu 22.04 / 24.04, Debian 12, Rocky Linux, or Fedora).

---

## 1. System Requirements

| Resource | Minimum | Recommended |
| :--- | :--- | :--- |
| **CPU** | 1 vCPU (x86_64 / arm64) | 2+ vCPUs |
| **RAM** | 2 GB | 4 GB+ |
| **Disk** | 20 GB SSD | 50 GB+ NVMe SSD |
| **OS** | Ubuntu 22.04+ / Debian 12+ | Ubuntu 24.04 LTS |
| **Docker** | Engine 24.0+ & Compose v2 | Docker CE 27.x |

---

## 2. Inbound Network & Firewall Ports

Ensure your cloud provider's firewall / security group allows the following inbound ports:

| Port | Protocol | Purpose | Visibility |
| :--- | :--- | :--- | :--- |
| **80** | TCP | HTTP Gateway (ACME challenges & redirects) | Public |
| **443** | TCP | HTTPS Gateway (TLS termination) | Public |
| **8081** | TCP | Web Console UI (Dashboard) | Public / VPN Restricted |
| **3001** | TCP | API Service (Control Plane direct) | Optional / Behind Gateway |
| **22** | TCP | SSH Server Access | Admin Only |

> [!NOTE]
> PostgreSQL (`5433:5432`) binds strictly to `127.0.0.1` and is never exposed to the public Internet.

---

## 3. Quick Start (One-Line Automated Installation)

Clone the repository to your host server and run the automated installer:

```bash
git clone https://github.com/Manishakumari21/DeployKit.git /opt/deploykit
cd /opt/deploykit
./install.sh
```

### What `install.sh` Does Automatically:
1. **Validates Host Prerequisites**: Confirms Docker Engine, Docker Compose v2, OpenSSL, and Curl.
2. **Generates Cryptographic Secrets**: Provisions a 64-character high-entropy `DEPLOYKIT_TOKEN_PEPPER` and strong random PostgreSQL database credentials into `.env`.
3. **Creates Isolated Networks**: Sets up `deploykit-default` and `deploykit-runtime` bridge networks.
4. **Initializes Database & Applies Migrations**: Starts PostgreSQL and reconciles all 24 schema migrations with advisory locks.
5. **Builds & Launches the Stack**: Boots the API, Worker, OpenResty Gateway, Local Registry, and Web Console.
6. **Verifies Health**: Polls `/api/health` until the control plane reports healthy.

---

## 4. First-Time Administrator Setup

1. Open your browser and navigate to:
   ```text
   http://<YOUR_SERVER_IP>:8081
   ```
2. When the database is newly initialized, DeployKit displays the **Initial Admin Registration** screen.
3. Enter your administrative email and password.
4. Once created, public registration automatically locks down (`DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION=false`).
5. All subsequent team members must be invited via secure, one-time invite tokens generated from the **Users → Invites** management view.

---

## 5. Domain & Reverse Proxy Configuration (Production)

To point a custom domain (e.g. `deploykit.yourcompany.com`) to DeployKit:

1. Create a DNS **A Record**:
   ```dns
   deploykit.yourcompany.com.  IN  A  <YOUR_SERVER_IP>
   ```
2. Configure your `.env`:
   ```bash
   DEPLOYKIT_WEB_ORIGIN=https://deploykit.yourcompany.com
   DEPLOYKIT_API_ORIGIN=https://deploykit.yourcompany.com
   DEPLOYKIT_ACME_EMAIL=admin@yourcompany.com
   DEPLOYKIT_ACME_SERVER=https://acme-v02.api.letsencrypt.org/directory
   ```
3. Restart the stack:
   ```bash
   docker compose up -d
   ```

---

## 6. Managing the Service

```bash
# Check status of all containers
docker compose ps

# Tail all logs in real time
docker compose logs -f

# Tail API service logs only
docker compose logs -f api

# Restart the stack
docker compose restart

# Stop the stack
docker compose down
```

---

## 7. Troubleshooting

### PostgreSQL fails to start
Check file permissions and container logs:
```bash
docker logs deploykit-postgres
```

### Port 80 or 443 already in use
If Apache or standalone Nginx is already installed on the host:
```bash
sudo systemctl stop nginx apache2
sudo systemctl disable nginx apache2
./install.sh
```

### Resetting or verifying database migrations
Check migration reconciliation status:
```bash
cd apps/api
npm run db:reconcile -- --check-only
```
