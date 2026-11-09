import test from "node:test";
import assert from "node:assert/strict";
import {
  generateNodeDockerfile,
  generatePythonDockerfile,
  generateRustDockerfile,
  generateGoDockerfile,
  generateStaticDockerfile,
  generateDockerfileForStack,
} from "./dockerfileGenerator.js";
import type { StackDetection } from "./stackDetector.js";

test("Node.js generator creates multi-stage non-root container with npm", () => {
  const dockerfile = generateNodeDockerfile({
    packageManager: "npm",
    buildCommand: "npm run build",
    startCommand: "node dist/index.js",
    port: 3000,
  });

  assert.ok(dockerfile.includes("FROM node:20-alpine AS builder"));
  assert.ok(dockerfile.includes("FROM node:20-alpine AS runner"));
  assert.ok(dockerfile.includes("RUN npm ci"));
  assert.ok(dockerfile.includes("RUN npm run build"));
  assert.ok(dockerfile.includes('USER appuser'));
  assert.ok(dockerfile.includes("EXPOSE 3000"));
  assert.ok(dockerfile.includes('["sh", "-c", "node dist/index.js"]'));
});

test("Node.js generator handles pnpm, yarn, and bun package managers", () => {
  const pnpmDf = generateNodeDockerfile({ packageManager: "pnpm" });
  assert.ok(pnpmDf.includes("pnpm install --frozen-lockfile"));
  assert.ok(pnpmDf.includes("pnpm-lock.yaml"));

  const yarnDf = generateNodeDockerfile({ packageManager: "yarn" });
  assert.ok(yarnDf.includes("yarn install --frozen-lockfile"));
  assert.ok(yarnDf.includes("yarn.lock"));

  const bunDf = generateNodeDockerfile({ packageManager: "bun" });
  assert.ok(bunDf.includes("bun install --frozen-lockfile"));
  assert.ok(bunDf.includes("bun.lock"));
});

test("Python generator creates multi-stage non-root container with virtualenv", () => {
  const dockerfile = generatePythonDockerfile({
    framework: "fastapi",
    port: 8000,
  });

  assert.ok(dockerfile.includes("FROM python:3.11-slim AS builder"));
  assert.ok(dockerfile.includes("FROM python:3.11-slim AS runner"));
  assert.ok(dockerfile.includes("python -m venv /opt/venv"));
  assert.ok(dockerfile.includes("USER appuser"));
  assert.ok(dockerfile.includes("EXPOSE 8000"));
  assert.ok(dockerfile.includes('["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]'));
});

test("Python generator supports Flask framework and custom commands", () => {
  const flaskDf = generatePythonDockerfile({ framework: "flask", port: 5000 });
  assert.ok(flaskDf.includes("--port=5000"));

  const customDf = generatePythonDockerfile({ startCommand: "gunicorn -w 4 app:app" });
  assert.ok(customDf.includes('["sh", "-c", "gunicorn -w 4 app:app"]'));
});

test("Rust generator creates multi-stage container with musl alpine builder", () => {
  const dockerfile = generateRustDockerfile({ port: 8080 });

  assert.ok(dockerfile.includes("FROM rust:1.76-alpine AS builder"));
  assert.ok(dockerfile.includes("FROM alpine:3.19 AS runner"));
  assert.ok(dockerfile.includes("musl-dev"));
  assert.ok(dockerfile.includes("cargo build --release"));
  assert.ok(dockerfile.includes("USER appuser"));
  assert.ok(dockerfile.includes("EXPOSE 8080"));
});

test("Go generator creates minimal alpine runtime with non-root user", () => {
  const dockerfile = generateGoDockerfile({ port: 8080 });

  assert.ok(dockerfile.includes("FROM golang:1.22-alpine AS builder"));
  assert.ok(dockerfile.includes("FROM alpine:3.19 AS runner"));
  assert.ok(dockerfile.includes("go mod download"));
  assert.ok(dockerfile.includes("CGO_ENABLED=0 GOOS=linux go build"));
  assert.ok(dockerfile.includes("USER appuser"));
  assert.ok(dockerfile.includes("EXPOSE 8080"));
  assert.ok(dockerfile.includes('CMD ["/app/server"]'));
});

test("Static generator creates unprivileged nginx container with default port 8080", () => {
  const dockerfile = generateStaticDockerfile({ outputDirectory: "dist" });

  assert.ok(dockerfile.includes("nginxinc/nginx-unprivileged:alpine"));
  assert.ok(dockerfile.includes("COPY dist ."));
  assert.ok(dockerfile.includes("EXPOSE 8080"));
  assert.ok(!dockerfile.includes("sed -i"));
});

test("Static generator supports explicit custom port overrides with nginx sed rewrite", () => {
  const dockerfile = generateStaticDockerfile({ outputDirectory: "dist", port: 3000 });

  assert.ok(dockerfile.includes("nginxinc/nginx-unprivileged:alpine"));
  assert.ok(dockerfile.includes("RUN sed -i -E 's/listen\\s+8080;/listen 3000;/g' /etc/nginx/conf.d/default.conf"));
  assert.ok(dockerfile.includes("COPY dist ."));
  assert.ok(dockerfile.includes("EXPOSE 3000"));
});

test("generateDockerfileForStack routes correctly according to detection and overrides", () => {
  const mockDetection: StackDetection = {
    kind: "go",
    hasDockerfile: false,
    packageManager: "go",
    detail: "Go app",
    language: "go",
    framework: "none",
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
    evidence: [],
    suggestions: [],
    confidence: "high",
    needsReview: false,
  };

  const goDf = generateDockerfileForStack(mockDetection);
  assert.ok(goDf.includes("FROM golang:1.22-alpine"));

  const overridden = generateDockerfileForStack(mockDetection, {
    builder: "node",
    buildCommand: "npm run build",
    startCommand: "npm start",
  });
  assert.ok(overridden.includes("FROM node:20-alpine"));
  assert.ok(overridden.includes("RUN npm run build"));
});

test("Python generator supports Poetry and Pipenv package managers", () => {
  const poetryDf = generatePythonDockerfile({ packageManager: "poetry" });
  assert.ok(poetryDf.includes("COPY pyproject.toml poetry.lock* ./"));
  assert.ok(poetryDf.includes("pip install --no-cache-dir poetry"));
  assert.ok(poetryDf.includes("poetry install --no-root"));

  const pipenvDf = generatePythonDockerfile({ packageManager: "pipenv" });
  assert.ok(pipenvDf.includes("COPY Pipfile Pipfile.lock* ./"));
  assert.ok(pipenvDf.includes("pip install --no-cache-dir pipenv"));
  assert.ok(pipenvDf.includes("pipenv install --system --deploy"));
});

test("Go generator supports custom entrypoint in build command", () => {
  const goCmdDf = generateGoDockerfile({
    buildCommand: "go build -ldflags=\"-w -s\" -o /app/server ./cmd/server",
    port: 9000,
  });
  assert.ok(goCmdDf.includes("CGO_ENABLED=0 GOOS=linux go build -ldflags=\"-w -s\" -o /app/server ./cmd/server"));
  assert.ok(goCmdDf.includes("EXPOSE 9000"));
});

test("generator rejects commands containing newline characters", () => {
  assert.throws(
    () => generateNodeDockerfile({ buildCommand: "npm run build\nRUN echo injected" }),
    /Command must not contain newline characters/
  );
  assert.throws(
    () => generateNodeDockerfile({ startCommand: "npm start\nRUN echo injected" }),
    /Command must not contain newline characters/
  );
  assert.throws(
    () => generateStaticDockerfile({ outputDirectory: "dist\nRUN echo injected" }),
    /Output directory must not contain newline characters/
  );
});

test("generator safely formats shell bracket commands vs JSON arrays", () => {
  const bracketDf = generateNodeDockerfile({
    startCommand: "[ -f .env ] && node server.js",
  });
  assert.ok(bracketDf.includes('CMD ["sh", "-c", "[ -f .env ] && node server.js"]'));

  const jsonDf = generateNodeDockerfile({
    startCommand: '["node", "server.js"]',
  });
  assert.ok(jsonDf.includes('CMD ["node", "server.js"]'));
});

test("generator sanitizes invalid ports and bounds", () => {
  const zeroDf = generateNodeDockerfile({ port: 0 });
  assert.ok(zeroDf.includes("EXPOSE 3000"));
  assert.ok(zeroDf.includes("PORT=3000"));

  const negativeDf = generateNodeDockerfile({ port: -80 });
  assert.ok(negativeDf.includes("EXPOSE 3000"));

  const outOfRangeDf = generateNodeDockerfile({ port: 70000 });
  assert.ok(outOfRangeDf.includes("EXPOSE 3000"));

  const nanDf = generateNodeDockerfile({ port: NaN });
  assert.ok(nanDf.includes("EXPOSE 3000"));
});

test("static generator quotes output directories with spaces", () => {
  const spaceDf = generateStaticDockerfile({ outputDirectory: "my build dist" });
  assert.ok(spaceDf.includes('COPY ["my build dist", "."]'));
});
