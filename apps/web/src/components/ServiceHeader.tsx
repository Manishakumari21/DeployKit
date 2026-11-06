import { ExternalLink, GitBranch, GitPullRequest, Hammer, RotateCw } from "lucide-react";
import { shortRepo } from "../lib/format";
import type { ApiDeployment, Project } from "../types";
import { DeployBtn, Eyebrow, Panel, QuietBtn, StatusPill } from "./ui";

export function ServiceHeader({
  project,
  live,
  creating,
  onDeploy,
  onBuildConfig,
}: {
  project: Project | undefined;
  live: ApiDeployment | undefined;
  creating: boolean;
  onDeploy: () => void;
  onBuildConfig?: () => void;
}) {
  if (!project)
    return (
      <Panel className="border-dashed p-8 text-center">
        <p className="text-sm font-semibold text-fog-100">No services yet</p>
        <p className="mt-1 text-[13px] text-fog-500">Connect a Git repository to launch your first service.</p>
      </Panel>
    );

  const commit = live?.commit_sha ? live.commit_sha.slice(0, 7) : "—";
  const gatewayHost = `dk-p${project.id.replace(/-/g, "").slice(0, 8).toLowerCase()}.deploykit.local`;

  return (
    <section aria-label="Service" className="dk-panel relative overflow-hidden rounded-2xl">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(600px 160px at 12% -40px, rgb(62 207 142 / 0.14), transparent 70%)",
        }}
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Eyebrow>{project.is_preview ? "Preview Environment" : "Active service"}</Eyebrow>
            {project.is_preview && (
              <span className="inline-flex items-center gap-1 rounded border border-purple-500/40 bg-purple-950/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-purple-300">
                <GitPullRequest size={10} /> PR #{project.pr_number}
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
            <h1
              className="truncate text-2xl font-bold tracking-tight text-balance text-white sm:text-[28px] sm:leading-8"
              style={{ letterSpacing: "-0.02em" }}
            >
              {project.name}
            </h1>
            {live && <StatusPill status={live.status} />}
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px]">
            <a
              href={project.repository_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-ink-950 px-2 py-1 font-mono text-fog-200 transition hover:border-fog-500 hover:text-white"
            >
              <GitBranch size={12} className="text-signal-300" />
              {shortRepo(project.repository_url)}
            </a>
            <span className="rounded-md border border-edge bg-ink-950 px-2 py-1 font-mono text-fog-400">
              {project.branch} · {commit}
            </span>
            {project.auto_deploy && (
              <span
                title="Continuous deployment enabled on push"
                className="inline-flex items-center gap-1 rounded-md border border-signal-500/30 bg-signal-950/60 px-2 py-1 font-mono text-[11px] font-medium text-signal-300"
              >
                <span className="size-1.5 rounded-full bg-signal-400" />
                auto-deploy
              </span>
            )}
            {live?.status === "active" && (
              <a
                href={`http://${gatewayHost}`}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open ${gatewayHost} in new tab`}
                className="inline-flex items-center gap-1 rounded-md border border-signal-500/30 bg-signal-950 px-2 py-1 font-mono text-signal-300 transition hover:border-signal-400 hover:text-signal-200"
              >
                <span>{gatewayHost}</span>
                <ExternalLink size={11} />
              </a>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onBuildConfig && (
            <QuietBtn type="button" onClick={onBuildConfig} aria-label="Open build configuration">
              <Hammer size={14} />
              Build config
            </QuietBtn>
          )}
          <DeployBtn onClick={onDeploy} disabled={creating} aria-label="Redeploy service">
            <RotateCw size={14} className={creating ? "animate-spin-slower" : ""} />
            {creating ? "Deploying…" : "Redeploy"}
          </DeployBtn>
        </div>
      </div>
    </section>
  );
}
