import { useState } from "react";
import { timeAgo } from "../lib/format";
import { useDeploymentLogs } from "../hooks/useDeploymentLogs";
import type { ApiDeployment } from "../types";
import { Panel, PanelHead } from "./ui";

export function DomainsView() {
  return (
    <Panel>
      <PanelHead title="Domains" />
      <p className="p-6 text-center text-[13px] text-zinc-500">
        Custom domains are not configured. Apps are reachable on the runtime network via the gateway.
      </p>
    </Panel>
  );
}

const LEVEL_STYLE: Record<string, string> = {
  debug: "text-zinc-500",
  info: "text-zinc-300",
  warn: "text-amber-300",
  error: "text-red-300",
};

const SOURCES = ["", "system", "git", "build", "registry", "runtime", "healthcheck", "worker", "gateway"];
const LEVELS = ["", "debug", "info", "warn", "error"];

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
    <div className="flex flex-col gap-3">
      <Panel>
        <PanelHead
          title="Logs"
          right={
            <span className="font-mono text-[11px] text-zinc-600">
              {logs.length} lines{truncated ? " · truncated" : ""}
            </span>
          }
        />
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-[12px]">
          <select
            aria-label="Deployment"
            value={selectedId ?? ""}
            onChange={(e) => onSelect(e.target.value)}
            className="max-w-64 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-zinc-200 outline-none"
          >
            {deployments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id.slice(0, 8)} · {d.status} · {d.branch}
              </option>
            ))}
          </select>
          <select
            aria-label="Source filter"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-zinc-200 outline-none"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>{s || "all sources"}</option>
            ))}
          </select>
          <select
            aria-label="Level filter"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-zinc-200 outline-none"
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l || "all levels"}</option>
            ))}
          </select>
        </div>
        {truncated && (
          <p className="border-b border-amber-900/50 bg-amber-950/30 px-4 py-2 text-[12px] text-amber-200">
            Logs truncated: retention or per-deployment limits were hit. See API for the truncation marker.
          </p>
        )}
        {loading && <p className="p-6 text-center text-[13px] text-zinc-500">Loading logs…</p>}
        {!loading && error && <p className="p-6 text-center text-[13px] text-red-300">{error}</p>}
        {!loading && !error && logs.length === 0 && (
          <p className="p-6 text-center text-[13px] text-zinc-500">
            No operational logs yet for this deployment. Logs appear as git, build, runtime, and healthcheck output is captured.
          </p>
        )}
        {!loading && !error && logs.length > 0 && (
          <ul className="max-h-[480px] divide-y divide-zinc-800/70 overflow-y-auto font-mono text-[12px]">
            {logs.map((l) => (
              <li key={l.id} className="px-4 py-1.5">
                <span className="text-zinc-600">{timeAgo(l.created_at)} </span>
                <span className="text-sky-300">[{l.source}] </span>
                <span className={LEVEL_STYLE[l.level] ?? "text-zinc-300"}>{l.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function SettingsView() {
  return (
    <div className="grid gap-2 lg:grid-cols-2">
      <Panel>
        <PanelHead title="General" />
        <div className="flex flex-col gap-3 p-4 text-[13px]">
          <label className="flex flex-col gap-1 font-medium text-zinc-300">
            Workspace name
            <input defaultValue="acme-prod" className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-600" />
          </label>
          <label className="flex flex-col gap-1 font-medium text-zinc-300">
            Default branch
            <input defaultValue="main" className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-zinc-100 outline-none focus:border-zinc-600" />
          </label>
        </div>
      </Panel>
      <Panel>
        <PanelHead title="Environment variables" right={<span className="font-mono text-[11px] text-zinc-500">.env · encrypted</span>} />
        <table className="w-full text-left font-mono text-[12px]">
          <tbody className="divide-y divide-zinc-800/70">
            {[["DATABASE_URL", "postgres://•••"], ["REDIS_URL", "redis://•••"], ["API_TOKEN", "dk_••••••••"]].map(([k, v]) => (
              <tr key={k}>
                <td className="px-4 py-2.5 text-zinc-100">{k}</td>
                <td className="px-4 py-2.5 text-zinc-500">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel className="border-red-900/60 lg:col-span-2">
        <PanelHead title="Danger zone" />
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 text-[13px]">
          <p className="text-zinc-400">Delete this workspace and all services. This cannot be undone.</p>
          <button className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 font-semibold text-red-200 hover:bg-red-950">Delete workspace</button>
        </div>
      </Panel>
    </div>
  );
}
