import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/format";
import type { DeployStatus } from "../types";

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-xl border border-zinc-800 bg-zinc-900/60", className)}>
      {children}
    </div>
  );
}

export function PanelHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
      <h3 className="text-[13px] font-semibold tracking-tight text-zinc-200">{title}</h3>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

type Btn = ButtonHTMLAttributes<HTMLButtonElement>;

export function DeployBtn({ className, children, ...r }: Btn) {
  return (
    <button
      className={cx(
        "inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3.5 py-2 text-[13px] font-semibold text-zinc-950 transition hover:bg-white disabled:opacity-50",
        className
      )}
      {...r}
    >
      {children}
    </button>
  );
}

export function QuietBtn({ className, children, ...r }: Btn) {
  return (
    <button
      className={cx(
        "inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-[13px] font-medium text-zinc-300 transition hover:border-zinc-700 hover:text-white disabled:opacity-50",
        className
      )}
      {...r}
    >
      {children}
    </button>
  );
}

const STATUS: Record<DeployStatus, { dot: string; text: string; label: string }> = {
  ready: { dot: "bg-emerald-400", text: "text-emerald-300", label: "Ready" },
  building: { dot: "bg-amber-300 animate-pulse", text: "text-amber-200", label: "Building" },
  failed: { dot: "bg-red-400", text: "text-red-300", label: "Failed" },
  queued: { dot: "bg-zinc-500", text: "text-zinc-400", label: "Queued" },
};

export function StatusPill({ status }: { status: DeployStatus }) {
  const s = STATUS[status];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] font-semibold", s.text)}>
      <span className={cx("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

export function Avatar({ name }: { name: string }) {
  const init = name.slice(0, 2).toUpperCase();
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-zinc-700 to-zinc-800 text-[10px] font-bold text-zinc-200 ring-1 ring-zinc-700">
      {init}
    </span>
  );
}

export function Meter({ value, tone = "bg-emerald-400" }: { value: number; tone?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
      <div className={cx("h-full rounded-full", tone)} style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

export function Spark({ points, className }: { points: number[]; className?: string }) {
  const max = Math.max(...points, 1);
  const d = points.map((v, i) => `${(i / (points.length - 1)) * 96},${28 - (v / max) * 24}`).join(" ");
  return (
    <svg viewBox="0 0 96 32" className={cx("h-8 w-24", className)} fill="none">
      <polyline points={d} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">
      {children}
    </kbd>
  );
}
