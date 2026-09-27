import { GitBranch, Plus, RotateCw, Search } from "lucide-react";
import { cx } from "../lib/format";
import { DeployBtn, Kbd, QuietBtn } from "./ui";

export function Topbar({
  env,
  setEnv,
  query,
  setQuery,
  refreshing,
  onRefresh,
  onNew,
  onDeploy,
}: {
  env: "production" | "preview";
  setEnv: (e: "production" | "preview") => void;
  query: string;
  setQuery: (q: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onNew: () => void;
  onDeploy: () => void;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
        {/* env tabs like Vercel */}
        <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-[12px]">
          {(["production", "preview"] as const).map((e) => (
            <button
              key={e}
              onClick={() => setEnv(e)}
              className={cx(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 capitalize transition",
                env === e ? "bg-zinc-700 font-semibold text-white" : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              <GitBranch size={12} /> {e}
            </button>
          ))}
        </div>

        <div className="relative min-w-44 flex-1 sm:max-w-xs">
          <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search services, commits…"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pr-12 pl-8 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
          />
          <span className="absolute top-1/2 right-2 hidden -translate-y-1/2 gap-0.5 sm:flex">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <QuietBtn onClick={onRefresh} title="Sync git + rebuild list">
            <RotateCw size={14} className={refreshing ? "animate-spin" : ""} />
            <span className="hidden sm:inline">{refreshing ? "Syncing…" : "Sync"}</span>
          </QuietBtn>
          <QuietBtn onClick={onNew}>
            <Plus size={14} /> <span className="hidden sm:inline">Service</span>
          </QuietBtn>
          <DeployBtn onClick={onDeploy}>Deploy</DeployBtn>
        </div>
      </div>
    </header>
  );
}
