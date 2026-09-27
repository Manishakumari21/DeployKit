import { Copy, Globe, Lock, Plus } from "lucide-react";
import type { Domain } from "../types";
import { Panel, PanelHead } from "./ui";

export function DomainsView({ domains, onNew }: { domains: Domain[]; onNew: () => void }) {
  return (
    <Panel>
      <PanelHead
        title="Domains"
        right={
          <button onClick={onNew} className="inline-flex items-center gap-1 text-[12px] font-medium text-zinc-400 hover:text-white">
            <Plus size={13} /> Add domain
          </button>
        }
      />
      {domains.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-zinc-500">No domains yet — create a service first.</p>
      ) : (
        <ul className="divide-y divide-zinc-800/70">
          {domains.map((d) => (
            <li key={d.host} className="flex flex-wrap items-center gap-2 px-4 py-3">
              <Globe size={15} className="text-zinc-500" />
              <span className="font-mono text-[13px] text-zinc-100">{d.host}</span>
              {d.primary && (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-bold text-zinc-950">PRIMARY</span>
              )}
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                <Lock size={11} /> SSL {d.ssl ? "active" : "pending"}
              </span>
              <span className="ml-auto flex items-center gap-2 text-[12px] text-zinc-500">
                {d.projectName}
                <button
                  onClick={() => navigator.clipboard.writeText(`https://${d.host}`).catch(() => {})}
                  className="rounded-md border border-zinc-800 p-1.5 hover:text-white"
                  aria-label="Copy domain"
                >
                  <Copy size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function LogsView({ lines, service }: { lines: string[]; service: string }) {
  return (
    <Panel className="overflow-hidden">
      <PanelHead
        title={`logs — ${service}`}
        right={<span className="flex gap-1.5">{["bg-red-400", "bg-amber-300", "bg-emerald-400"].map((c) => <span key={c} className={`size-2.5 rounded-full ${c}`} />)}</span>}
      />
      <div className="bg-zinc-950 p-4 font-mono text-[12px] leading-6">
        {lines.map((l, i) => (
          <p key={i} className={l.startsWith("✓") ? "text-emerald-300" : l.startsWith("→") ? "text-sky-300" : "text-zinc-400"}>
            <span className="mr-2 text-zinc-700 select-none">{String(i + 1).padStart(2, "0")}</span>
            {l}
          </p>
        ))}
        <p className="mt-1 text-zinc-500">
          <span className="mr-2 text-zinc-700 select-none">›</span>
          <span className="inline-block h-4 w-2 animate-pulse bg-zinc-400 align-middle" />
        </p>
      </div>
    </Panel>
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
