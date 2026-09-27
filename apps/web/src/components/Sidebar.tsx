import {
  Boxes,
  Clock,
  Globe,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
} from "lucide-react";
import { cx } from "../lib/format";
import type { NavKey } from "../types";

const GROUPS: { title: string; items: { key: NavKey; label: string; icon: typeof Server }[] }[] = [
  {
    title: "Manage",
    items: [
      { key: "overview", label: "Overview", icon: LayoutDashboard },
      { key: "services", label: "Services", icon: Boxes },
      { key: "deployments", label: "Deployments", icon: Clock },
    ],
  },
  {
    title: "Observability",
    items: [
      { key: "domains", label: "Domains", icon: Globe },
      { key: "logs", label: "Logs", icon: ScrollText },
    ],
  },
  {
    title: "Admin",
    items: [{ key: "settings", label: "Settings", icon: Settings }],
  },
];

export function Sidebar({
  nav,
  setNav,
  counts,
  healthy,
}: {
  nav: NavKey;
  setNav: (n: NavKey) => void;
  counts: Record<string, number>;
  healthy: boolean | null;
}) {
  return (
    <aside className="flex w-full flex-row gap-4 overflow-x-auto border-b border-zinc-800 bg-zinc-950 p-3 lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:flex-col lg:overflow-visible">
      <button className="flex min-w-44 items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-left">
        <span className="grid size-7 place-items-center rounded-md bg-zinc-100 text-sm font-black text-zinc-950">▲</span>
        <span className="leading-tight">
          <span className="block text-[13px] font-semibold text-white">acme-prod</span>
          <span className="flex items-center gap-1 text-[11px] text-zinc-500">
            <span className={cx("size-1.5 rounded-full", healthy === null ? "bg-amber-300" : healthy ? "bg-emerald-400" : "bg-red-400")} />
            {healthy === null ? "connecting" : healthy ? "connected" : "offline"}
          </span>
        </span>
        <span className="ml-auto text-zinc-600">⇅</span>
      </button>

      <nav className="flex flex-row gap-4 lg:flex-col lg:gap-5">
        {GROUPS.map((g) => (
          <div key={g.title} className="flex flex-row items-center gap-1 lg:flex-col lg:items-stretch">
            <p className="hidden px-2 text-[10px] font-semibold tracking-widest text-zinc-600 uppercase lg:block">{g.title}</p>
            {g.items.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setNav(key)}
                className={cx(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] whitespace-nowrap transition",
                  nav === key ? "bg-zinc-800 font-semibold text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                )}
              >
                <Icon size={15} className={nav === key ? "text-white" : "text-zinc-500"} />
                {label}
                {counts[key] ? (
                  <span className="ml-auto rounded-full bg-zinc-800 px-1.5 text-[11px] text-zinc-300">{counts[key]}</span>
                ) : null}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="mt-auto hidden lg:block">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <div className="flex justify-between text-[11px] text-zinc-400">
            <span>Build minutes</span>
            <span className="font-mono text-zinc-200">312 / 1000</span>
          </div>
          <div className="mt-2 h-1 rounded-full bg-zinc-800">
            <div className="h-full w-[31%] rounded-full bg-zinc-100" />
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">Self-hosted · unlimited bandwidth</p>
        </div>
        <div className="mt-2 flex items-center gap-2 px-1 py-2">
          <span className="grid size-7 place-items-center rounded-full bg-zinc-800 text-[11px] font-bold text-zinc-200">M</span>
          <div className="leading-tight">
            <p className="text-[12px] font-medium text-zinc-200">manisha</p>
            <p className="text-[11px] text-zinc-500">Owner</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
