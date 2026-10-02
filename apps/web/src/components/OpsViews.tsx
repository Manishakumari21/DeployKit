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

export function LogsView() {
  return (
    <Panel className="overflow-hidden">
      <PanelHead title="Logs" />
      <p className="p-6 text-center text-[13px] text-zinc-500">
        Container logs are not available in this version. Use <span className="font-mono">docker logs</span> on the
        runtime host to inspect the active container.
      </p>
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
