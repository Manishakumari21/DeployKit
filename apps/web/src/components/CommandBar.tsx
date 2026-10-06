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

const ITEMS: { key: NavKey; label: string; icon: typeof Server; group: string }[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, group: "run" },
  { key: "services", label: "Services", icon: Boxes, group: "run" },
  { key: "deployments", label: "Deploys", icon: Clock, group: "run" },
  { key: "logs", label: "Logs", icon: ScrollText, group: "observe" },
  { key: "domains", label: "Domains", icon: Globe, group: "observe" },
  { key: "settings", label: "Settings", icon: Settings, group: "observe" },
];

/**
 * Command deck — replaces the sidebar. Brand + health on the left,
 * segmented mission nav in the middle, operator on the right.
 */
export function CommandBar({
  nav,
  setNav,
  counts,
  healthy,
  userEmail,
  onLogout,
}: {
  nav: NavKey;
  setNav: (n: NavKey) => void;
  counts: Record<string, number>;
  healthy: boolean | null;
  userEmail: string;
  onLogout: () => void;
}) {
  return (
    <div className="border-b border-edge bg-ink-950/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-signal-400 font-mono text-sm font-bold text-ink-950 shadow-[0_8px_24px_-10px_rgb(62_207_142/0.8)]">
            ▚
          </span>
          <span className="leading-tight">
            <span className="block text-[14px] font-bold tracking-tight text-white">
              deploykit
            </span>
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-fog-500">
              <span
                className={cx(
                  "size-1.5 rounded-full",
                  healthy === null
                    ? "animate-pulse bg-amber-300"
                    : healthy
                      ? "bg-signal-400"
                      : "bg-red-400"
                )}
              />
              {healthy === null ? "linking…" : healthy ? "api live" : "api down"}
            </span>
          </span>
        </div>

        <nav aria-label="Primary" className="order-3 flex w-full items-center gap-1 overflow-x-auto sm:order-2 sm:w-auto sm:flex-1 sm:justify-center">
          {ITEMS.map(({ key, label, icon: Icon }) => {
            const active = nav === key;
            return (
              <button
                key={key}
                onClick={() => setNav(key)}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] whitespace-nowrap transition duration-200 active:scale-[0.98]",
                  active
                    ? "bg-ink-700 font-semibold text-white shadow-[inset_0_1px_0_rgb(194_220_245/0.08)]"
                    : "text-fog-500 hover:bg-ink-800 hover:text-fog-100"
                )}
              >
                <Icon size={14} className={active ? "text-signal-300" : "text-fog-500"} />
                {label}
                {typeof counts[key] === "number" && counts[key] > 0 ? (
                  <span
                    className={cx(
                      "rounded-md px-1.5 font-mono text-[11px]",
                      active ? "bg-ink-950 text-fog-200" : "bg-ink-800 text-fog-500"
                    )}
                  >
                    {counts[key]}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="order-2 ml-auto hidden items-center gap-2 sm:order-3 sm:flex">
          <span className="rounded-md border border-edge bg-ink-800 px-2 py-1 font-mono text-[10px] tracking-wider text-fog-500 uppercase">
            self-hosted
          </span>
          <span
            title={userEmail}
            className="grid size-7 place-items-center rounded-lg bg-ink-700 text-[11px] font-bold text-fog-200 ring-1 ring-edge"
          >
            {userEmail.slice(0, 1).toUpperCase()}
          </span>
          <button
            onClick={onLogout}
            title={`Sign out ${userEmail}`}
            className="cursor-pointer rounded-lg border border-edge bg-ink-800 px-2.5 py-1.5 text-[12px] font-medium text-fog-400 transition hover:border-fog-500 hover:text-white"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
