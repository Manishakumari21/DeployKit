import { RotateCw } from "lucide-react";
import type { ApiDeployment, Project } from "../types";
import { Panel } from "./ui";
import { StatusPill } from "./ui";

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
        <p className="text-sm font-semibold text-zinc-200">No services yet</p>
        <p className="mt-1 text-[13px] text-zinc-500">Add a Git repository to create your first service.</p>
      </Panel>
    );
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-zinc-100 text-sm font-black text-zinc-950">
          {project.name.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-tight text-white">{project.name}</h1>
            {live && <StatusPill status={live.status} />}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[12px] text-zinc-500">
            <span className="truncate">{project.repository_url}</span>
            <span className="rounded bg-zinc-900 px-1.5 py-0.5 ring-1 ring-zinc-800">
              {project.branch} · {live?.commit_sha ? live.commit_sha.slice(0, 7) : "—"}
            </span>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={onDeploy}
          disabled={creating}
          aria-label="Deploy project"
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3.5 py-2 text-[13px] font-semibold text-zinc-950 transition hover:bg-white disabled:opacity-50"
        >
          <RotateCw size={14} /> {creating ? "Deploying…" : "Redeploy"}
        </button>
      </div>
    </div>
  );
}
