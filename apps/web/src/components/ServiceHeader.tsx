import { ArrowUpRight, Copy, GitBranch, RotateCw } from "lucide-react";
import { useState } from "react";
import { fakeMetrics } from "../lib/deploy";
import { timeAgo } from "../lib/format";
import type { Deployment, Project } from "../types";
import { Meter, Panel, QuietBtn, Spark, StatusPill } from "./ui";

export function ServiceHeader({ project, live }: { project: Project | undefined; live: Deployment | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!project)
    return (
      <Panel className="border-dashed p-8 text-center">
        <p className="text-sm font-semibold text-zinc-200">No services yet</p>
        <p className="mt-1 text-[13px] text-zinc-500">Add a Git repository to create your first service.</p>
      </Panel>
    );
  const url = `${project.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.deploykit.local`;
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
            <span className="inline-flex items-center gap-1 rounded bg-zinc-900 px-1.5 py-0.5 ring-1 ring-zinc-800">
              <GitBranch size={11} /> {project.branch} · {live?.commit ?? "—"}
            </span>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => {
            navigator.clipboard.writeText(`https://${url}`).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 font-mono text-[12px] text-zinc-300 hover:text-white"
        >
          <span className="size-1.5 rounded-full bg-emerald-400" /> {url}
          {copied ? <span className="text-emerald-300">copied</span> : <Copy size={12} className="text-zinc-500" />}
        </button>
        <QuietBtn>
          <ArrowUpRight size={14} /> Visit
        </QuietBtn>
        <QuietBtn>
          <RotateCw size={14} /> Redeploy
        </QuietBtn>
      </div>
    </div>
  );
}

export function MetricsRow({ projects }: { projects: Project[] }) {
  if (!projects.length) return null;
  const m = fakeMetrics(projects[0].id);
  const tiles = [
    { label: "Production deploy", big: projects[0].name, sub: timeAgo(projects[0].created_at), spark: m.spark, tone: "text-emerald-300" },
    { label: "Build duration", big: m.build, sub: "cached · vite", spark: m.spark.slice().reverse(), tone: "text-zinc-200" },
    { label: "Availability", big: m.uptime, sub: "last 30 days", spark: m.spark, tone: "text-emerald-300" },
    { label: "CPU / Memory", big: `${m.cpu}% / ${m.ram}%`, sub: "1 vCPU · 512MB", spark: m.spark.slice(4), tone: "text-amber-200" },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
      {tiles.map((t) => (
        <Panel key={t.label} className="flex items-center justify-between gap-2 p-3.5">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{t.label}</p>
            <p className="mt-1 truncate text-[15px] font-semibold text-white">{t.big}</p>
            <p className="text-[11px] text-zinc-500">{t.sub}</p>
          </div>
          <Spark points={t.spark} className={t.tone} />
        </Panel>
      ))}
    </div>
  );
}

export function ResourceBars({ projects }: { projects: Project[] }) {
  const rows = projects.slice(0, 4).map((p) => ({ p, m: fakeMetrics(p.id) }));
  if (!rows.length) return null;
  return (
    <Panel className="p-3.5">
      <p className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">Resources</p>
      <div className="mt-2 flex flex-col gap-2.5">
        {rows.map(({ p, m }) => (
          <div key={p.id}>
            <div className="mb-1 flex justify-between text-[12px]">
              <span className="truncate font-medium text-zinc-200">{p.name}</span>
              <span className="font-mono text-zinc-500">{m.cpu}% cpu</span>
            </div>
            <Meter value={m.cpu} tone={m.cpu > 70 ? "bg-amber-300" : "bg-emerald-400"} />
          </div>
        ))}
      </div>
    </Panel>
  );
}
