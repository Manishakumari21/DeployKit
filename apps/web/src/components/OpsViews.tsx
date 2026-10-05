import { useState } from "react";
import { timeAgo } from "../lib/format";
import { useDeploymentLogs } from "../hooks/useDeploymentLogs";
import type { ApiDeployment } from "../types";
import { EmptyState, Eyebrow, Panel, PanelHead } from "./ui";
import { cx } from "../lib/format";

export function DomainsView() {
  return (
    <Panel>
      <PanelHead title="Domains" />
      <EmptyState
        title="No custom domains on the scope"
        body="Services answer on the runtime network through the gateway. Custom domains with TLS land here when configured."
      />
    </Panel>
  );
}

const LEVEL_STYLE: Record<string, string> = {
  debug: "text-fog-500",
  info: "text-fog-200",
  warn: "text-amber-300",
  error: "text-red-300",
};

const SOURCES = ["system", "git", "build", "registry", "runtime", "healthcheck", "worker", "gateway"];
const LEVELS = ["debug", "info", "warn", "error"];

export function LogsView({
  deployments,
  selectedId,
  onSelect,
}: {
  deployments: ApiDeployment[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [source, setSource] = useState("");
  const [level, setLevel] = useState("");
  const { logs, truncated, loading, error } = useDeploymentLogs(selectedId, {
    ...(source ? { source } : {}),
    ...(level ? { level } : {}),
  });

  return (
    <Panel className="overflow-hidden">
      {/* Terminal chrome */}
      <div className="flex items-center gap-1.5 border-b border-edge bg-ink-950 px-4 py-2.5">
        <span aria-hidden className="size-2.5 rounded-full bg-red-400/70" />
        <span aria-hidden className="size-2.5 rounded-full bg-amber-300/70" />
        <span aria-hidden className="size-2.5 rounded-full bg-signal-400/70" />
        <span className="ml-2 font-mono text-[11px] text-fog-500">
          deploykit — flight log{selectedId ? ` · ${selectedId.slice(0, 8)}` : ""}
        </span>
        <span className="ml-auto font-mono text-[11px] text-fog-500 tabular">
          {logs.length} lines{truncated ? " · truncated" : ""}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2.5">
        <div className="flex max-w-full items-center gap-1 overflow-x-auto" role="group" aria-label="Deployment">
          {deployments.slice(0, 12).map((d) => (
            <button
              key={d.id}
              onClick={() => onSelect(d.id)}
              aria-pressed={d.id === selectedId}
              className={cx(
                "shrink-0 cursor-pointer rounded-md border px-2 py-1 font-mono text-[11px] transition duration-200 active:scale-[0.98]",
                d.id === selectedId
                  ? "border-signal-500/50 bg-signal-950 text-signal-300"
                  : "border-edge bg-ink-800 text-fog-500 hover:text-fog-200"
              )}
            >
              {d.id.slice(0, 8)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-edge px-4 py-2">
        <FilterChip active={source === ""} onClick={() => setSource("")} label="all systems" />
        {SOURCES.map((s) => (
          <FilterChip key={s} active={source === s} onClick={() => setSource(source === s ? "" : s)} label={s} />
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-edge" />
        <FilterChip active={level === ""} onClick={() => setLevel("")} label="all levels" />
        {LEVELS.map((l) => (
          <FilterChip key={l} active={level === l} onClick={() => setLevel(level === l ? "" : l)} label={l} />
        ))}
      </div>

      {truncated && (
        <p className="border-b border-amber-900/50 bg-amber-950/30 px-4 py-2 text-[12px] text-amber-200">
          Output truncated — retention or per-deployment limits were hit. The truncation marker is in the stream.
        </p>
      )}
      {loading && <p className="p-6 text-center font-mono text-[13px] text-fog-500">tuning in…</p>}
      {!loading && error && <p className="p-6 text-center text-[13px] text-red-300">{error}</p>}
      {!loading && !error && logs.length === 0 && (
        <EmptyState
          title="Channel is quiet"
          body="No operational output for this flight yet. Git chatter, build stream, runtime and healthcheck diagnostics land here as the deployment runs."
        />
      )}
      {!loading && !error && logs.length > 0 && (
        <ul className="max-h-[480px] overflow-y-auto bg-ink-950/70 font-mono text-[12px] leading-relaxed">
          {logs.map((l) => (
            <li key={l.id} className="flex gap-2 border-b border-edge/40 px-4 py-1 hover:bg-ink-800/50">
              <span className="shrink-0 text-fog-500 tabular">{timeAgo(l.created_at)}</span>
              <span className="shrink-0 text-signal-400/80">[{l.source}]</span>
              <span className={cx("min-w-0 flex-1 break-words whitespace-pre-wrap", LEVEL_STYLE[l.level] ?? "text-fog-200")}>
                {l.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "shrink-0 cursor-pointer rounded-full border px-2.5 py-1 font-mono text-[11px] transition duration-200 active:scale-[0.97]",
        active
          ? "border-signal-500/50 bg-signal-950 text-signal-300"
          : "border-edge bg-transparent text-fog-500 hover:border-fog-500 hover:text-fog-200"
      )}
    >
      {label}
    </button>
  );
}

export function SettingsView() {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Panel>
        <PanelHead title="Workspace" />
        <div className="flex flex-col gap-3 p-4 text-[13px]">
          <Eyebrow>Identity</Eyebrow>
          <label className="flex flex-col gap-1 font-medium text-fog-200">
            Workspace name
            <input defaultValue="acme-prod" className="rounded-lg border border-edge bg-ink-950 px-3 py-2 text-fog-100 outline-none focus:border-signal-500" />
          </label>
          <label className="flex flex-col gap-1 font-medium text-fog-200">
            Default branch
            <input defaultValue="main" className="rounded-lg border border-edge bg-ink-950 px-3 py-2 font-mono text-fog-100 outline-none focus:border-signal-500" />
          </label>
        </div>
      </Panel>
      <Panel>
        <PanelHead title="Environment" right={<span className="font-mono text-[11px] text-fog-500">.env · sealed</span>} />
        <table className="w-full text-left font-mono text-[12px]">
          <tbody className="divide-y divide-edge/70">
            {[["DATABASE_URL", "postgres://•••"], ["REDIS_URL", "redis://•••"], ["API_TOKEN", "dk_••••••••"]].map(([k, v]) => (
              <tr key={k}>
                <td className="px-4 py-2.5 text-fog-100">{k}</td>
                <td className="px-4 py-2.5 text-fog-500">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel className="border-red-900/60 lg:col-span-2">
        <PanelHead title="Danger zone" />
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 text-[13px]">
          <p className="text-fog-400">Delete this workspace and all services. This cannot be undone.</p>
          <button className="cursor-pointer rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 font-semibold text-red-200 transition hover:bg-red-950 active:scale-[0.98]">Delete workspace</button>
        </div>
      </Panel>
    </div>
  );
}
