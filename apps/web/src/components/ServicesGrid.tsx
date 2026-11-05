import { GitBranch, GitPullRequest, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { timeAgo } from "../lib/format";
import type { Project } from "../types";
import { DeployBtn, EmptyState, Panel, Skeleton } from "./ui";

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
  const [filter, setFilter] = useState<"all" | "production" | "previews">("all");

  const previewCount = useMemo(() => projects.filter((p) => p.is_preview).length, [projects]);
  const prodCount = useMemo(() => projects.filter((p) => !p.is_preview).length, [projects]);

  const filtered = useMemo(() => {
    if (filter === "production") return projects.filter((p) => !p.is_preview);
    if (filter === "previews") return projects.filter((p) => p.is_preview);
    return projects;
  }, [projects, filter]);

  if (loading)
    return (
      <Panel>
        <div className="flex flex-col gap-2 p-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      </Panel>
    );

  if (!projects.length)
    return (
      <Panel>
        <EmptyState
          title="No services on the roster"
          body="A service mirrors one Git repository and branch. Connect a repo and DeployKit takes it from clone to live."
          action={
            <DeployBtn onClick={onNew}>
              <Plus size={14} /> Connect a repository
            </DeployBtn>
          }
        />
      </Panel>
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 font-mono text-[12px]">
        <button
          onClick={() => setFilter("all")}
          className={`cursor-pointer rounded-lg px-2.5 py-1 transition ${
            filter === "all" ? "bg-ink-800 font-semibold text-white" : "text-fog-500 hover:text-fog-200"
          }`}
        >
          All ({projects.length})
        </button>
        <button
          onClick={() => setFilter("production")}
          className={`cursor-pointer rounded-lg px-2.5 py-1 transition ${
            filter === "production" ? "bg-ink-800 font-semibold text-white" : "text-fog-500 hover:text-fog-200"
          }`}
        >
          Production ({prodCount})
        </button>
        <button
          onClick={() => setFilter("previews")}
          className={`cursor-pointer rounded-lg px-2.5 py-1 transition ${
            filter === "previews" ? "bg-purple-950 font-semibold text-purple-300" : "text-fog-500 hover:text-fog-200"
          }`}
        >
          PR Previews ({previewCount})
        </button>
      </div>

      <Panel>
        <ul className="divide-y divide-edge/70">
          {filtered.length === 0 ? (
            <li className="p-6 text-center text-[13px] text-fog-500">
              No services match the active filter.
            </li>
          ) : (
            filtered.map((p) => {
              const active = selectedId === p.id;
              return (
                <li key={p.id}>
                  <div
                    className={`group flex items-center gap-3 px-4 py-3 transition duration-200 ${
                      active ? "bg-signal-950/40" : "hover:bg-ink-800/60"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`h-9 w-1 shrink-0 rounded-full ${
                        active
                          ? "bg-signal-400"
                          : p.is_preview
                          ? "bg-purple-500/80"
                          : "bg-ink-700 group-hover:bg-fog-500"
                      }`}
                    />
                    <button
                      onClick={() => onSelect?.(p.id)}
                      className="min-w-0 flex-1 cursor-pointer text-left"
                      aria-label={`Select ${p.name}`}
                      aria-pressed={active}
                    >
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="truncate text-[14px] font-semibold text-white">{p.name}</span>
                        {p.is_preview && (
                          <span className="inline-flex items-center gap-1 rounded border border-purple-500/40 bg-purple-950/80 px-1.5 font-mono text-[10px] font-medium text-purple-300">
                            <GitPullRequest size={10} /> PR #{p.pr_number}
                          </span>
                        )}
                        <span className="font-mono text-[11px] text-fog-500">
                          {p.id.slice(0, 8)}
                        </span>
                        {active && (
                          <span className="rounded border border-signal-500/40 bg-signal-950 px-1.5 font-mono text-[10px] font-medium text-signal-300">
                            TRACKED
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-fog-500">
                        <span className="inline-flex items-center gap-1">
                          <GitBranch size={11} /> {p.branch}
                        </span>
                        <span className="truncate">{p.repository_url}</span>
                        <span>· {timeAgo(p.created_at)}</span>
                      </span>
                    </button>
                    <DeleteService id={p.id} onDelete={onDelete} />
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </Panel>
    </div>
  );
}

function DeleteService({ id, onDelete }: { id: string; onDelete: (id: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 2600);
    return () => clearTimeout(t);
  }, [confirm]);
  return (
    <button
      onClick={() => {
        if (!confirm) {
          setConfirm(true);
          return;
        }
        onDelete(id);
      }}
      onBlur={() => setConfirm(false)}
      className={`inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-[12px] transition duration-200 active:scale-[0.98] ${
        confirm ? "bg-red-950 font-semibold text-red-200" : "text-fog-500 hover:bg-ink-700 hover:text-red-300"
      }`}
    >
      <Trash2 size={13} /> {confirm ? "Confirm" : "Remove"}
    </button>
  );
}
