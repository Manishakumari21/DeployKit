import { describe, expect, test } from "vitest";
import { getDockerfilePreview } from "./dockerfilePreview";

describe("dockerfilePreview", () => {
  test("generates generic Python preview with python main.py", () => {
    const preview = getDockerfilePreview("python");
    expect(preview).toContain("FROM python:3.11-slim AS builder");
    expect(preview).toContain("FROM python:3.11-slim AS runner");
    expect(preview).toContain('CMD ["python", "main.py"]');
    expect(preview).toContain("EXPOSE 8000");
    expect(preview).toContain("PORT=8000");
  });

  test("generates FastAPI preview with uvicorn and custom port", () => {
    const preview = getDockerfilePreview("python", {
      framework: "fastapi",
      port: 8080,
    });
    expect(preview).toContain('CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]');
    expect(preview).toContain("EXPOSE 8080");
    expect(preview).toContain("PORT=8080");
  });

  test("generates Flask preview with python -m flask run and custom port", () => {
    const preview = getDockerfilePreview("python", {
      framework: "flask",
      port: 5000,
    });
    expect(preview).toContain('CMD ["python", "-m", "flask", "run", "--host=0.0.0.0", "--port=5000"]');
    expect(preview).toContain("EXPOSE 5000");
    expect(preview).toContain("PORT=5000");
  });

  test("generates Poetry preview when packageManager is poetry", () => {
    const preview = getDockerfilePreview("python", {
      packageManager: "poetry",
    });
    expect(preview).toContain("COPY pyproject.toml poetry.lock* ./");
    expect(preview).toContain("pip install --no-cache-dir poetry");
  });

  test("generates Go preview with custom build command", () => {
    const preview = getDockerfilePreview("go", {
      buildCommand: "go build -ldflags=\"-w -s\" -o /app/server ./cmd/api",
      port: 9000,
    });
    expect(preview).toContain("RUN CGO_ENABLED=0 GOOS=linux go build -ldflags=\"-w -s\" -o /app/server ./cmd/api");
    expect(preview).toContain("EXPOSE 9000");
  });

  test("generates default static preview with unprivileged nginx on port 8080", () => {
    const preview = getDockerfilePreview("static", {
      outputDirectory: "dist",
    });
    expect(preview).toContain("FROM nginxinc/nginx-unprivileged:alpine AS runner");
    expect(preview).toContain("COPY dist .");
    expect(preview).toContain("EXPOSE 8080");
    expect(preview).not.toContain("sed -i");
  });

  test("generates static preview with custom port override and nginx sed rewrite", () => {
    const preview = getDockerfilePreview("static", {
      outputDirectory: "build",
      port: 3000,
    });
    expect(preview).toContain("FROM nginxinc/nginx-unprivileged:alpine AS runner");
    expect(preview).toContain("RUN sed -i -E 's/listen\\s+8080;/listen 3000;/g' /etc/nginx/conf.d/default.conf");
    expect(preview).toContain("COPY build .");
    expect(preview).toContain("EXPOSE 3000");
  });

  test("generates Node preview with pnpm and validates npm install -g pnpm", () => {
    const preview = getDockerfilePreview("node", {
      packageManager: "pnpm",
    });
    expect(preview).toContain("RUN npm install -g pnpm");
    expect(preview).not.toContain("install-g");
    expect(preview).toContain("RUN pnpm install --frozen-lockfile");
    expect(preview).toContain('CMD ["pnpm", "start"]');
  });

  test("generates Node preview with bun and validates npm install -g bun", () => {
    const preview = getDockerfilePreview("node", {
      packageManager: "bun",
    });
    expect(preview).toContain("RUN npm install -g bun");
    expect(preview).toContain("RUN bun install --frozen-lockfile");
    expect(preview).toContain('CMD ["bun", "run", "start"]');
  });

  test("generates Poetry preview with poetry config virtualenvs.create false", () => {
    const preview = getDockerfilePreview("python", {
      packageManager: "poetry",
    });
    expect(preview).toContain("poetry config virtualenvs.create false");
    expect(preview).not.toContain("configvirtualenvs");
    expect(preview).toContain("pip install --no-cache-dir poetry");
  });

  test("generates Go preview with default build command using -o /app/server", () => {
    const preview = getDockerfilePreview("go");
    expect(preview).toContain('RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/server .');
    expect(preview).toContain("-o /app/server");
    expect(preview).not.toContain("-o/app/server");
    expect(preview).toContain('CMD ["/app/server"]');
    expect(preview).toContain("EXPOSE 8080");
  });

  test("generates default Rust preview with port 8080", () => {
    const preview = getDockerfilePreview("rust");
    expect(preview).toContain("FROM rust:1.76-alpine AS builder");
    expect(preview).toContain("FROM alpine:3.19 AS runner");
    expect(preview).toContain("EXPOSE 8080");
    expect(preview).toContain('CMD ["sh", "-c", "exec $(find /app -maxdepth 1 -type f -executable | head -n 1)"]');
  });

  test("generates Rust preview respecting custom port override", () => {
    const preview = getDockerfilePreview("rust", {
      port: 9090,
    });
    expect(preview).toContain("EXPOSE 9090");
    expect(preview).not.toContain("EXPOSE 8080");
  });

  test("generates preview safely formatting shell bracket commands vs JSON arrays", () => {
    const bracketPreview = getDockerfilePreview("node", {
      startCommand: "[ -f .env ] && node server.js",
    });
    expect(bracketPreview).toContain('CMD ["sh", "-c", "[ -f .env ] && node server.js"]');

    const jsonPreview = getDockerfilePreview("node", {
      startCommand: '["node", "server.js"]',
    });
    expect(jsonPreview).toContain('CMD ["node", "server.js"]');
  });

  test("generates preview sanitizing invalid ports and bounds", () => {
    const zeroPreview = getDockerfilePreview("node", { port: 0 });
    expect(zeroPreview).toContain("EXPOSE 3000");
    expect(zeroPreview).toContain("PORT=3000");

    const negativePreview = getDockerfilePreview("node", { port: -3000 });
    expect(negativePreview).toContain("EXPOSE 3000");

    const nanPreview = getDockerfilePreview("node", { port: NaN });
    expect(nanPreview).toContain("EXPOSE 3000");
  });

  test("generates static preview quoting output directories with spaces", () => {
    const spacePreview = getDockerfilePreview("static", { outputDirectory: "my build dist" });
    expect(spacePreview).toContain('COPY ["my build dist", "."]');
  });

  test("generates preview collapsing command newlines into single line", () => {
    const newlinePreview = getDockerfilePreview("node", {
      buildCommand: "npm run build\nRUN echo injected",
      startCommand: "npm start\nRUN echo injected",
    });
    expect(newlinePreview).toContain("RUN npm run build RUN echo injected");
    expect(newlinePreview).toContain('CMD ["sh", "-c", "npm start RUN echo injected"]');
  });
});
