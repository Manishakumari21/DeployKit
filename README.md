# DeployKit

DeployKit is a self-hosted deployment platform that helps developers deploy applications from Git repositories.

The goal is to understand and build the core systems behind modern deployment platforms.

## Tech Stack

* TypeScript
* Node.js
* Express
* React
* PostgreSQL
* Docker
* Nginx
* GitHub Actions

## Architecture

```text
GitHub
   ↓
DeployKit
   ↓
Build
   ↓
Docker
   ↓
Application
```

## Project Structure

```text
deploykit/
├── apps/
│   ├── api/          # Backend API
│   └── web/          # Web dashboard
├── database/         # Database files
├── docs/             # Documentation
├── .env.example
├── .gitignore
└── README.md
```

## Development

### API

```bash
cd apps/api
npm install
npm run dev
```

API:

```text
http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/api/health
```

Expected:

```json
{
  "status": "ok"
}
```

## Goal

DeployKit will eventually handle:

* Git repository integration
* Application builds
* Docker deployments
* Health checks
* Logs
* Rollbacks
* CI/CD
* Monitoring
* Infrastructure automation
# DeployKit
