import type { Request, Response } from "express";
import { getAllowedOrigins } from "../config/corsConfig.js";
import {
  getGitHubConnection,
  listGitHubRepositories,
  recordGitHubInstallation,
  GitHubConnectionError,
} from "../services/githubConnectionService.js";
import {
  verifyGitHubState,
  GitHubStateError,
} from "../infrastructure/github/githubState.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function webOrigin(): string {
  return getAllowedOrigins()[0];
}

function apiOrigin(req: Request): string {
  const configured = process.env.DEPLOYKIT_API_ORIGIN;
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, "");
  const publicOrigin = getAllowedOrigins()[0];
  if (publicOrigin) return publicOrigin;
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

function renderPage(
  res: Response,
  status: number,
  heading: string,
  message: string,
  origin: string,
  close: boolean
): void {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)} · DeployKit</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: #0a0d12;
    color: #e6edf4;
    font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  }
  main {
    width: min(100%, 420px);
    border: 1px solid #223041;
    border-radius: 16px;
    padding: 28px;
    background: linear-gradient(180deg, rgb(24 32 44 / 0.72), rgb(15 20 27 / 0.9));
    box-shadow: inset 0 1px 0 rgb(194 220 245 / 0.07), 0 12px 32px -16px rgb(0 0 0 / 0.7);
  }
  .mark {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: #3ecf8e;
    color: #0a0d12;
    font: 700 15px ui-monospace, monospace;
  }
  .eyebrow {
    margin: 16px 0 0;
    color: #5d6f86;
    font: 500 11px ui-monospace, monospace;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  h1 { margin: 6px 0 0; font-size: 22px; letter-spacing: -0.02em; }
  p { margin: 10px 0 0; color: #8496ab; font-size: 14px; line-height: 1.6; }
  a { display: inline-block; margin-top: 18px; color: #7dedb0; font-weight: 600; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <span class="mark" aria-hidden="true">▚</span>
  <p class="eyebrow">deploykit</p>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(message)}</p>
  <a href="${escapeHtml(origin)}">Return to DeployKit</a>
</main>
${close ? "<script>setTimeout(function(){window.close()},1200)</script>" : ""}
</body>
</html>`;
  res.status(status).set("Cache-Control", "no-store").type("html").send(html);
}

export async function getGitHubConnectionController(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const connection = await getGitHubConnection(
      req.auth!.userId,
      `${apiOrigin(req)}/api/github/callback`
    );
    res.json(connection);
  } catch {
    res.status(500).json({ error: "Failed to check the GitHub connection" });
  }
}

export async function listGitHubRepositoriesController(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    res.json(await listGitHubRepositories());
  } catch (error) {
    if (error instanceof GitHubConnectionError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    res.status(500).json({ error: "Failed to load GitHub repositories" });
  }
}

export async function githubCallbackController(
  req: Request,
  res: Response
): Promise<void> {
  const origin = webOrigin();
  const state = typeof req.query.state === "string" ? req.query.state : "";
  try {
    verifyGitHubState(state);
  } catch (error) {
    const message =
      error instanceof GitHubStateError && error.code === "STATE_EXPIRED"
        ? "The GitHub connection request expired. Return to DeployKit and try again."
        : "The GitHub connection request could not be verified. Return to DeployKit and try again.";
    renderPage(res, 400, "GitHub connection failed", message, origin, false);
    return;
  }
  const installationId =
    typeof req.query.installation_id === "string" ? req.query.installation_id : "";
  if (!installationId) {
    renderPage(
      res,
      400,
      "GitHub connection failed",
      "GitHub did not return an installation ID. Return to DeployKit and try again.",
      origin,
      false
    );
    return;
  }
  try {
    await recordGitHubInstallation(installationId);
  } catch (error) {
    if (error instanceof GitHubConnectionError) {
      renderPage(res, 400, "GitHub connection failed", error.message, origin, false);
      return;
    }
    renderPage(
      res,
      500,
      "GitHub connection failed",
      "The GitHub installation could not be saved. Return to DeployKit and try again.",
      origin,
      false
    );
    return;
  }
  renderPage(
    res,
    200,
    "GitHub connected",
    "Return to DeployKit and refresh the repository list to choose a repository.",
    origin,
    true
  );
}
