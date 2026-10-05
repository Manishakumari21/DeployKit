import { Plus, RotateCw, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { DeployBtn, Kbd, QuietBtn } from "./ui";

export function Topbar({
  query,
  setQuery,
  refreshing,
  onRefresh,
  onNew,
  onDeploy,
  deploying,
  canDeploy,
}: {
  query: string;
  setQuery: (q: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onNew: () => void;
  onDeploy: () => void;
  deploying: boolean;
  canDeploy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="border-b border-edge bg-ink-950/60">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
        <div className="relative min-w-44 flex-1 sm:max-w-xs">
          <Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-fog-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter services…"
            aria-label="Filter services"
            className="w-full rounded-lg border border-edge bg-ink-900 py-1.5 pr-12 pl-8 text-[13px] text-fog-100 shadow-[inset_0_1px_0_rgb(194_220_245/0.05)] outline-none placeholder:text-fog-500 focus:border-signal-500"
          />
          <span className="absolute top-1/2 right-2 hidden -translate-y-1/2 gap-0.5 sm:flex" aria-hidden>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <QuietBtn onClick={onRefresh} title="Reload services and deployments">
            <RotateCw size={14} className={refreshing ? "animate-spin-slower" : ""} />
            <span className="hidden sm:inline">{refreshing ? "Syncing…" : "Sync"}</span>
          </QuietBtn>
          <QuietBtn onClick={onNew}>
            <Plus size={14} /> <span className="hidden sm:inline">Service</span>
          </QuietBtn>
          <DeployBtn onClick={onDeploy} disabled={!canDeploy || deploying}>
            {deploying ? "Deploying…" : "▸ Deploy"}
          </DeployBtn>
        </div>
      </div>
    </div>
  );
}
