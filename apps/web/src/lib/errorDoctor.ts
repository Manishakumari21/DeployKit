import type { NavKey } from "../types";

export type Diagnosis = {
  category: string;
  headline: string;
  summary: string;
  beginnerTrap: string;
  recommendedSteps: string[];
  snippets?: { label: string; language: string; code: string }[];
  suggestedAction?: {
    label: string;
    targetTab: NavKey;
    icon: "settings" | "logs";
  };
};

export function diagnoseDeploymentError(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined
): Diagnosis {
  const code = (errorCode ?? "").toUpperCase();
  const msg = (errorMessage ?? "").toLowerCase();

  // 1. Health check failure / 0.0.0.0 vs localhost
  if (
    code === "HEALTH_CHECK_FAILED" ||
    msg.includes("health check") ||
    msg.includes("connection refused") ||
    msg.includes("econnrefused") ||
    msg.includes("timed out waiting for")
  ) {
    return {
      category: "Container Connectivity",
      headline: "Server Did Not Respond to Health Probes",
      summary:
        "DeployKit started your container, but health check probes failed to receive a valid HTTP response within the grace period.",
      beginnerTrap:
        "The #1 beginner pitfall in Docker: your server is listening on 127.0.0.1 (localhost) instead of 0.0.0.0. In a container, localhost only listens to itself, making it invisible to the reverse proxy.",
      recommendedSteps: [
        "Ensure your server listens on host 0.0.0.0, not 127.0.0.1 or localhost.",
        "Verify your application reads the PORT environment variable (or listens on port 3000 by default).",
        "Make sure your app exposes a health route (like GET / or /health) that returns HTTP 200.",
      ],
      snippets: [
        {
          label: "Node.js / Express",
          language: "javascript",
          code: `const port = process.env.PORT || 3000;\n// Must bind to 0.0.0.0 inside containers!\napp.listen(port, '0.0.0.0', () => {\n  console.log(\`Server listening on port \${port}\`);\n});`,
        },
        {
          label: "Python / FastAPI",
          language: "python",
          code: `import os, uvicorn\n\nif __name__ == "__main__":\n    port = int(os.environ.get("PORT", 8000))\n    # Bind to 0.0.0.0\n    uvicorn.run("main:app", host="0.0.0.0", port=port)`,
        },
        {
          label: "Next.js",
          language: "json",
          code: `// next.config.js\nmodule.exports = {\n  output: 'standalone', // recommended for production Docker\n};`,
        },
      ],
      suggestedAction: {
        label: "Check Environment & Port Settings",
        targetTab: "settings",
        icon: "settings",
      },
    };
  }

  // 2. Build failed / compiler errors / missing packages
  if (
    code === "BUILD_FAILED" ||
    code === "BUILD_TIMEOUT" ||
    code === "BUILD_EXECUTION_FAILED" ||
    msg.includes("build") ||
    msg.includes("failed to compile") ||
    msg.includes("syntax error") ||
    msg.includes("cannot find module")
  ) {
    const isMissingModule = msg.includes("cannot find module") || msg.includes("not found");
    return {
      category: "Application Build",
      headline: isMissingModule ? "Missing Package Dependency" : "Build Script Failed",
      summary:
        "The build command (npm run build or equivalent) failed during container image construction.",
      beginnerTrap: isMissingModule
        ? "A required package exists in your local node_modules but is missing from package.json dependencies."
        : "Code that builds locally might fail in a clean production container due to uncommitted files, strict TypeScript checks, or missing build-time environment variables.",
      recommendedSteps: [
        "Run `npm run build` locally in a clean terminal to reproduce and fix compiler errors.",
        "Check that all dependencies are saved in package.json (not just installed locally).",
        "If using Next.js or Vite, ensure all required NEXT_PUBLIC_* or VITE_* variables are set.",
      ],
      snippets: [
        {
          label: "Verify Build Locally",
          language: "bash",
          code: `# Clean test locally:\nrm -rf node_modules dist .next\nnpm ci\nnpm run build`,
        },
      ],
      suggestedAction: {
        label: "Inspect Full Flight Logs",
        targetTab: "logs",
        icon: "logs",
      },
    };
  }

  // 3. Container crash on startup (OOM or missing env)
  if (
    code === "RUNTIME_CONTAINER_NOT_RUNNING" ||
    code === "RUNTIME_FAILED" ||
    msg.includes("exit code 137") ||
    msg.includes("killed") ||
    msg.includes("crash")
  ) {
    const isOom = msg.includes("137") || msg.includes("killed") || msg.includes("out of memory");
    return {
      category: "Runtime Lifecycle",
      headline: isOom ? "Container Ran Out of Memory (OOM)" : "Container Crashed on Startup",
      summary: isOom
        ? "The application process was terminated by the Linux kernel because it exceeded the container memory limit (Exit code 137)."
        : "The container booted up but exited immediately with an error.",
      beginnerTrap: isOom
        ? "Build-heavy frameworks (like Next.js or Webpack) or memory-intensive servers can spike past 512MB RAM."
        : "Apps often crash on startup when an expected secret (like DATABASE_URL or JWT_SECRET) is missing and not handled gracefully with a try/catch.",
      recommendedSteps: [
        isOom
          ? "Increase memory allocation in Project Settings (e.g. from 512MB to 1024MB)."
          : "Verify all required environment variables are configured in Settings.",
        "Check your npm start or CMD command in package.json to ensure the startup path exists.",
      ],
      suggestedAction: {
        label: "Configure Project Settings & Secrets",
        targetTab: "settings",
        icon: "settings",
      },
    };
  }

  // 4. Git clone failed
  if (
    code === "CLONE_FAILED" ||
    msg.includes("git clone") ||
    msg.includes("repository") ||
    msg.includes("not found")
  ) {
    return {
      category: "Git Repository Access",
      headline: "Unable to Clone Source Repository",
      summary:
        "DeployKit was unable to fetch the source code from the configured Git URL or branch.",
      beginnerTrap:
        "Private repositories require GitHub App authorization, and branch names must match the remote repository exactly (e.g. 'main' vs 'master').",
      recommendedSteps: [
        "Verify the repository URL is spelled correctly.",
        "Check that the branch name exists on GitHub (e.g. 'main').",
        "If private, ensure the GitHub App integration is installed for this repository.",
      ],
      suggestedAction: {
        label: "Review Git Configuration in Settings",
        targetTab: "settings",
        icon: "settings",
      },
    };
  }

  // 5. Default / Fallback
  return {
    category: "Deployment Diagnostics",
    headline: "Flight Interrupted",
    summary:
      errorMessage ||
      "The deployment encountered an unexpected condition before reaching active status.",
    beginnerTrap:
      "Most deployment failures stem from missing environment variables, wrong port bindings, or uncommitted files.",
    recommendedSteps: [
      "Open the Flight Recorder logs to see the exact process output.",
      "Verify all required environment variables are defined in Project Settings.",
      "Ensure your application compiles and runs cleanly in a local production test.",
    ],
    suggestedAction: {
      label: "Review Full Flight Logs",
      targetTab: "logs",
      icon: "logs",
    },
  };
}
