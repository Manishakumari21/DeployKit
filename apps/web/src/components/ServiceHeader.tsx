import { GitBranch, RotateCw } from "lucide-react";
import { shortRepo } from "../lib/format";
import type { ApiDeployment, Project } from "../types";
import { DeployBtn, Eyebrow, Panel, StatusPill } from "./ui";

export function ServiceHeader({
  project,
  live,
  creating,
  onDeploy,
}: {
  project: Project | undefined;
  live: ApiDeployment | undefined;
  creating: boolean;
  onDeploy: () => void;
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
          <Eyebrow>Active service</Eyebrow>
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
            <span className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-ink-950 px-2 py-1 font-mono text-fog-200">
              <GitBranch size={12} className="text-signal-300" />
              {shortRepo(project.repository_url)}
            </span>
            <span className="rounded-md border border-edge bg-ink-950 px-2 py-1 font-mono text-fog-400">
              {project.branch} · {commit}
            </span>
            {live?.status === "active" && (
              <span className="rounded-md border border-signal-500/30 bg-signal-950 px-2 py-1 font-mono text-signal-300">
                {gatewayHost}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <DeployBtn onClick={onDeploy} disabled={creating} aria-label="Redeploy service">
            <RotateCw size={14} className={creating ? "animate-spin-slower" : ""} />
            {creating ? "Deploying…" : "Redeploy"}
          </DeployBtn>
        </div>
      </div>
    </section>
  );
}
