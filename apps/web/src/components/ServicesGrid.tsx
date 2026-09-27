import { ArrowUpRight, Copy, GitBranch, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { fakeMetrics } from "../lib/deploy";
import { timeAgo } from "../lib/format";
import type { Project } from "../types";
import { Meter, Panel, StatusPill } from "./ui";

export function ServicesGrid({
  projects,
  loading,
  onNew,
  onDelete,
}: {
  projects: Project[];
  loading: boolean;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  if (loading)
    return (
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-44 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/60" />
        ))}
      </div>
    );
  if (!projects.length)
    return (
      <Panel className="border-dashed p-10 text-center">
        <p className="font-semibold text-white">No services</p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] text-zinc-500">
          Services mirror a Git repo + branch — like Coolify resources or Railway services.
        </p>
        <button onClick={onNew} className="mx-auto mt-3 inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3.5 py-2 text-[13px] font-semibold text-zinc-950">
          <Plus size={14} /> New service
        </button>
      </Panel>
    );
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((p) => {
        const m = fakeMetrics(p.id);
        const host = `${p.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.deploykit.local`;
        return (
          <Panel key={p.id} className="group flex flex-col p-3.5 transition hover:border-zinc-700">
            <div className="flex items-center gap-2.5">
              <span className="grid size-9 place-items-center rounded-lg bg-zinc-100 text-[12px] font-black text-zinc-950">
                {p.name.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold text-white">{p.name}</p>
                <p className="flex items-center gap-1 font-mono text-[11px] text-zinc-500">
                  <GitBranch size={11} /> {p.branch} · {timeAgo(p.created_at)}
                </p>
              </div>
              <StatusPill status="ready" />
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(`https://${host}`).catch(() => {})}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-400 hover:text-zinc-100"
            >
              <span className="size-1.5 rounded-full bg-emerald-400" />
              <span className="truncate">{host}</span>
              <Copy size={11} className="ml-auto shrink-0" />
            </button>
            <div className="mt-2.5 flex flex-col gap-1.5">
              <Meter value={m.cpu} />
              <p className="flex justify-between font-mono text-[10px] text-zinc-600">
                <span>cpu {m.cpu}%</span>
                <span>ram {m.ram}%</span>
              </p>
            </div>
            <div className="mt-2.5 flex items-center gap-1.5 border-t border-zinc-800 pt-2.5">
              <button className="inline-flex items-center gap-1 text-[12px] font-medium text-zinc-400 hover:text-white">
                <ArrowUpRight size={13} /> Open
              </button>
              <button
                onClick={() => {
                  if (confirm !== p.id) {
                    setConfirm(p.id);
                    setTimeout(() => setConfirm((c) => (c === p.id ? null : c)), 2500);
                    return;
                  }
                  onDelete(p.id);
                }}
                className="ml-auto inline-flex items-center gap-1 text-[12px] text-zinc-500 hover:text-red-300"
              >
                <Trash2 size={13} /> {confirm === p.id ? "Confirm?" : "Remove"}
              </button>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
