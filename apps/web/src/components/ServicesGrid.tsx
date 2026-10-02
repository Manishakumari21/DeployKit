import { GitBranch, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { timeAgo } from "../lib/format";
import type { Project } from "../types";
import { Panel } from "./ui";

export function ServicesGrid({
  projects,
  loading,
  selectedId,
  onNew,
  onSelect,
  onDelete,
}: {
  projects: Project[];
  loading: boolean;
  selectedId?: string | null;
  onNew: () => void;
  onSelect?: (id: string) => void;
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
          Services mirror a Git repo + branch.
        </p>
        <button onClick={onNew} className="mx-auto mt-3 inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3.5 py-2 text-[13px] font-semibold text-zinc-950">
          <Plus size={14} /> New service
        </button>
      </Panel>
    );
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((p) => (
        <Panel
          key={p.id}
          className={`group flex flex-col p-3.5 transition hover:border-zinc-700 ${selectedId === p.id ? "border-zinc-500" : ""}`}
        >
          <button onClick={() => onSelect?.(p.id)} className="flex items-center gap-2.5 text-left" aria-label={`Select ${p.name}`}>
            <span className="grid size-9 place-items-center rounded-lg bg-zinc-100 text-[12px] font-black text-zinc-950">
              {p.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold text-white">{p.name}</span>
              <span className="flex items-center gap-1 font-mono text-[11px] text-zinc-500">
                <GitBranch size={11} /> {p.branch} · {timeAgo(p.created_at)}
              </span>
            </span>
          </button>
          <p className="mt-2 truncate font-mono text-[11px] text-zinc-500">{p.repository_url}</p>
          <div className="mt-2.5 flex items-center gap-1.5 border-t border-zinc-800 pt-2.5">
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
      ))}
    </div>
  );
}
