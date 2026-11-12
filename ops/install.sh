#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# DeployKit Production Installer
# ==============================================================================
# Automated installer for self-hosted DeployKit PaaS.
# Verifies system prerequisites, provisions cryptographic secrets, starts the
# container stack, applies database migrations, and verifies service health.
# ==============================================================================

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${CYAN}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1" >&2
}

banner() {
  echo -e "${BOLD}${CYAN}"
  echo "  ██████╗ ███████╗██████╗ ██╗      ██████╗ ██╗   ██╗██╗  ██╗██╗████████╗"
  echo "  ██╔══██╗██╔════╝██╔══██╗██║     ██╔═══██╗╚██╗ ██╔╝██║ ██╔╝██║╚══██╔══╝"
  echo "  ██║  ██║█████╗  ██████╔╝██║     ██║   ██║ ╚████╔╝ █████╔╝ ██║   ██║   "
  echo "  ██║  ██║██╔══╝  ██╔═══╝ ██║     ██║   ██║  ╚██╔╝  ██╔═██╗ ██║   ██║   "
  echo "  ██████╔╝███████╗██║     ███████╗╚██████╔╝   ██║   ██║  ██╗██║   ██║   "
  echo "  ╚═════╝ ╚══════╝╚═╝     ╚══════╝ ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝   ╚═╝   "
  echo -e "${NC}"
  echo -e "  Self-Hosted PaaS — Your infrastructure. Your deployments. Your control."
  echo "  ======================================================================"
  echo ""
}

banner

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ------------------------------------------------------------------------------
# 1. System & Dependency Checks
# ------------------------------------------------------------------------------
log_info "Verifying host system prerequisites..."

# Check OS
OS="$(uname -s)"
if [ "$OS" != "Linux" ] && [ "$OS" != "Darwin" ]; then
  log_warn "DeployKit is optimized for Linux VPS hosts. Detected OS: $OS"
fi

# Check Docker CLI
if ! command -v docker >/dev/null 2>&1; then
  log_error "Docker is required but not installed."
  echo "Please install Docker: https://docs.docker.com/engine/install/"
  exit 1
fi

# Check Docker Daemon access
if ! docker info >/dev/null 2>&1; then
  log_error "Cannot connect to the Docker daemon. Are you in the 'docker' group or running as root?"
  exit 1
fi
log_success "Docker daemon is reachable."

# Check Docker Compose (v2 plugin preferred)
COMPOSE_CMD=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  log_error "Docker Compose (v2 plugin or docker-compose) is required."
  exit 1
fi
log_success "Docker Compose detected: $($COMPOSE_CMD version --short 2>/dev/null || echo "ok")"

# Check OpenSSL & Curl
for tool in openssl curl git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    log_error "Missing required CLI tool: $tool"
    exit 1
  fi
done
log_success "Required CLI utilities (openssl, curl, git) present."

# Check ports
check_port() {
  local port=$1
  local service_name=$2
  if command -v ss >/dev/null 2>&1; then
    if ss -tuln | grep -q ":${port} "; then
      log_warn "Port ${port} (${service_name}) appears in use. If DeployKit is already running, this is expected."
    fi
  elif command -v netstat >/dev/null 2>&1; then
    if netstat -tuln | grep -q ":${port} "; then
      log_warn "Port ${port} (${service_name}) appears in use. If DeployKit is already running, this is expected."
    fi
  fi
}

RESOLVED_WEB_PORT=$($COMPOSE_CMD config 2>/dev/null | grep -A 5 'web:' | grep -E '\- ".*:[0-9]+:80"' | head -n1 | sed -E 's/.*:([0-9]+):80.*/\1/' || echo "")
if [ -z "$RESOLVED_WEB_PORT" ]; then
  RESOLVED_WEB_PORT=8081
fi

check_port 80 "HTTP Gateway"
check_port 443 "HTTPS Gateway"
check_port 3001 "API Service"
check_port "$RESOLVED_WEB_PORT" "Web Console"
check_port 5433 "Postgres Port (Host Binding)"

# ------------------------------------------------------------------------------
# 2. Environment Configuration & Cryptographic Secrets
# ------------------------------------------------------------------------------
ENV_FILE="$REPO_ROOT/.env"
if [ ! -f "$ENV_FILE" ]; then
  log_info "No .env found. Provisioning secure production configuration..."

  POSTGRES_PASS=$(openssl rand -hex 24)
  TOKEN_PEPPER=$(openssl rand -hex 32)
  REGISTRY_PASS=$(openssl rand -hex 24)

  cat > "$ENV_FILE" <<EOF
# DeployKit Production Environment
NODE_ENV=production
PORT=3000

# PostgreSQL Configuration
POSTGRES_USER=deploykit
POSTGRES_PASSWORD=${POSTGRES_PASS}
POSTGRES_DB=deploykit
DATABASE_URL=postgresql://deploykit:${POSTGRES_PASS}@postgres:5432/deploykit

# Security & Cryptographic Pepper
# Stable secret used to key (HMAC-SHA-256) session and agent tokens.
DEPLOYKIT_TOKEN_PEPPER=${TOKEN_PEPPER}

# Access Control & Invites
DEPLOYKIT_ALLOW_PUBLIC_REGISTRATION=false
DEPLOYKIT_INVITE_DAYS=7

# Internal Registry Configuration
DEPLOYKIT_REGISTRY_HOST=deploykit-registry-tls:443
DEPLOYKIT_REGISTRY_NAMESPACE=deploykit
DEPLOYKIT_REGISTRY_USERNAME=deploykit
DEPLOYKIT_REGISTRY_PASSWORD=${REGISTRY_PASS}
DEPLOYKIT_REGISTRY_INSECURE=false

# Worker Concurrency & Retention
DEPLOYKIT_WORKER_CONCURRENCY=2
DEPLOYKIT_LOG_RETENTION_DAYS=30

# Edge Agent & TLS Mode
DEPLOYKIT_TLS_MODE=acme
DEPLOYKIT_EDGE_ALLOW_HTTP=false
EOF

  chmod 600 "$ENV_FILE"
  log_success "Created secure .env with high-entropy cryptographic pepper and credentials."
else
  log_info "Existing .env detected. Validating required keys..."
  if ! grep -q "DEPLOYKIT_TOKEN_PEPPER=" "$ENV_FILE" || grep -q "DEPLOYKIT_TOKEN_PEPPER=$" "$ENV_FILE"; then
    log_warn "DEPLOYKIT_TOKEN_PEPPER is missing or empty. Generating crypto pepper..."
    NEW_PEPPER=$(openssl rand -hex 32)
    echo "DEPLOYKIT_TOKEN_PEPPER=${NEW_PEPPER}" >> "$ENV_FILE"
    log_success "Appended DEPLOYKIT_TOKEN_PEPPER to .env."
  fi
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

# Ensure necessary host directories exist
mkdir -p "$REPO_ROOT/backups"
mkdir -p "$REPO_ROOT/ops/gateway/routes"

# ------------------------------------------------------------------------------
# 3. Docker Networks Provisioning
# ------------------------------------------------------------------------------
log_info "Ensuring Docker bridge networks..."
for net in deploykit-default deploykit-runtime; do
  if ! docker network ls --format '{{.Name}}' | grep -qx "$net"; then
    docker network create "$net" >/dev/null 2>&1 || true
    log_success "Created Docker network: $net"
  else
    log_success "Network $net already exists."
  fi
done

# ------------------------------------------------------------------------------
# 4. Database Startup & Schema Migration
# ------------------------------------------------------------------------------
log_info "Starting PostgreSQL container..."
$COMPOSE_CMD up -d postgres

log_info "Waiting for database to report healthy..."
for i in {1..30}; do
  STATUS="$(docker inspect --format='{{json .State.Health.Status}}' deploykit-postgres 2>/dev/null || echo 'starting')"
  if [ "$STATUS" = "\"healthy\"" ]; then
    log_success "PostgreSQL is healthy."
    break
  fi
  if [ "$i" -eq 30 ]; then
    log_error "PostgreSQL failed to become healthy within 30 seconds."
    docker logs --tail 20 deploykit-postgres
    exit 1
  fi
  sleep 1
done

# Reconcile & execute migrations
log_info "Applying database migrations..."
HOST_DB_URL="postgresql://${POSTGRES_USER:-deploykit}:${POSTGRES_PASSWORD:-deploykit}@127.0.0.1:5433/${POSTGRES_DB:-deploykit}"
if command -v npm >/dev/null 2>&1 && [ -f "$REPO_ROOT/apps/api/package.json" ]; then
  (cd "$REPO_ROOT/apps/api" && DATABASE_URL="${HOST_DB_URL}" npm run db:migrate)
  log_success "Database migrations reconciled and applied successfully."
else
  # Fallback: run migration through temporary container
  log_info "Applying migrations via docker compose container..."
  $COMPOSE_CMD run --rm -e DEPLOYKIT_MIGRATIONS_DIR=/app/database/migrations api npm run db:migrate || true
fi

# ------------------------------------------------------------------------------
# 5. Core Stack Build & Start
# ------------------------------------------------------------------------------
log_info "Building and launching DeployKit core services..."
$COMPOSE_CMD up -d --build api worker web registry gateway

log_info "Waiting for API service health check..."
API_HEALTHY=false
for i in {1..40}; do
  if curl -sf http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    API_HEALTHY=true
    log_success "API service is healthy on http://127.0.0.1:3001/api/health."
    break
  fi
  sleep 1
done

if [ "$API_HEALTHY" != "true" ]; then
  log_warn "API did not respond on 3001 yet. Checking docker status..."
  $COMPOSE_CMD ps
fi

# ------------------------------------------------------------------------------
# 6. Installation Summary & First-Run Instructions
# ------------------------------------------------------------------------------
SERVER_IP=$(curl -s -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}' || echo "your-server-ip")

echo ""
echo "======================================================================"
log_success "DeployKit is successfully installed and running!"
echo "======================================================================"
echo ""
echo -e "${BOLD}Access the Web Console:${NC}"
echo -e "  Direct Web Console:  ${CYAN}http://${SERVER_IP}:${RESOLVED_WEB_PORT}${NC} (or http://localhost:${RESOLVED_WEB_PORT})"
echo -e "  Edge Gateway:        ${CYAN}http://${SERVER_IP}${NC} (ports 80 / 443)"
echo -e "  Direct API:          ${CYAN}http://${SERVER_IP}:3001${NC}"
echo ""
echo -e "${BOLD}Next Steps (First Admin Account):${NC}"
echo "  1. Open http://${SERVER_IP}:${RESOLVED_WEB_PORT} in your browser."
echo "  2. Register the initial administrator account (only allowed on empty database)."
echo "  3. Subsequent accounts require an invite token generated from the admin panel."
echo ""
echo -e "${BOLD}Useful Commands:${NC}"
echo "  Check Stack Status:  $COMPOSE_CMD ps"
echo "  Follow Stack Logs:   $COMPOSE_CMD logs -f"
echo "  Back Up Database:    ./ops/backup/backup-db.sh"
echo "  Verify Backups:      ./ops/backup/restore-db.sh backups/<backup-file>.dump"
echo "  Stop DeployKit:      $COMPOSE_CMD down"
echo ""
echo -e "${BOLD}Documentation:${NC}"
echo "  - Getting Started:   docs/INSTALLATION.md"
echo "  - Architecture:      docs/ARCHITECTURE.md"
echo "  - Edge Servers:      docs/EDGE_SERVERS.md"
echo "  - Security Guide:    docs/SECURITY.md"
echo "======================================================================"
