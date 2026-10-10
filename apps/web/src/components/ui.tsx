import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/format";
import type { DeployStatus } from "../types";

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("dk-panel rounded-2xl", className)}>{children}</div>;
}

export function PanelHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-edge px-4 py-2.5">
      <h3 className="text-[11px] font-semibold tracking-[0.14em] text-fog-400 uppercase">{title}</h3>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cx("text-[11px] font-medium tracking-[0.16em] text-fog-500 uppercase", className)}>
      {children}
    </p>
  );
}

type Btn = ButtonHTMLAttributes<HTMLButtonElement>;

export function DeployBtn({ className, children, ...r }: Btn) {
  return (
    <button
      className={cx(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-signal-400 px-3.5 py-2 text-[13px] font-semibold text-ink-950 shadow-[0_8px_24px_-10px_rgb(62_207_142/0.7)] transition duration-200 hover:bg-signal-300 hover:shadow-[0_8px_28px_-8px_rgb(62_207_142/0.8)] active:translate-y-px active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-signal-400",
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
        "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-edge bg-ink-800 px-3 py-2 text-[13px] font-medium text-fog-200 transition duration-200 hover:border-fog-500 hover:text-white active:translate-y-px active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...r}
    >
      {children}
    </button>
  );
}

export function DangerBtn({ className, children, ...r }: Btn) {
  return (
    <button
      className={cx(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-red-900/70 bg-red-950/50 px-3 py-2 text-[13px] font-semibold text-red-200 transition duration-200 hover:bg-red-950 active:translate-y-px active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...r}
    >
      {children}
    </button>
  );
}

const STATUS: Record<DeployStatus, { dot: string; ring: string; text: string; label: string; live?: boolean }> = {
  queued: { dot: "bg-fog-500", ring: "border-edge", text: "text-fog-400", label: "Queued" },
  cloning: { dot: "bg-amber-300 animate-pulse", ring: "border-amber-300/30", text: "text-amber-200", label: "Cloning", live: true },
  building: { dot: "bg-amber-300 animate-pulse", ring: "border-amber-300/30", text: "text-amber-200", label: "Building", live: true },
  pushing: { dot: "bg-amber-300 animate-pulse", ring: "border-amber-300/30", text: "text-amber-200", label: "Pushing", live: true },
  verifying: { dot: "bg-amber-300 animate-pulse", ring: "border-amber-300/30", text: "text-amber-200", label: "Verifying", live: true },
  deploying: { dot: "bg-amber-300 animate-pulse", ring: "border-amber-300/30", text: "text-amber-200", label: "Deploying", live: true },
  active: { dot: "bg-signal-400", ring: "border-signal-400/40", text: "text-signal-300", label: "Live" },
  failed: { dot: "bg-red-400", ring: "border-red-400/40", text: "text-red-300", label: "Failed" },
  cancelled: { dot: "bg-fog-500", ring: "border-edge", text: "text-fog-500", label: "Cancelled" },
};

export function StatusPill({ status }: { status: DeployStatus }) {
  const s = STATUS[status];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border bg-ink-950 px-2 py-0.5 font-mono text-[11px] font-medium",
        s.ring,
        s.text
      )}
    >
      <span className={cx("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

export function Avatar({ name }: { name: string }) {
  const init = name.slice(0, 2).toUpperCase();
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-ink-700 text-[10px] font-bold text-signal-300 ring-1 ring-edge">
      {init}
    </span>
  );
}

export function Meter({ value, tone = "bg-signal-400" }: { value: number; tone?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
      <div className={cx("h-full rounded-full transition-[width] duration-500", tone)} style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

export function Spark({ points, className }: { points: number[]; className?: string }) {
  const max = Math.max(...points, 1);
  const d = points.map((v, i) => `${(i / (points.length - 1)) * 96},${28 - (v / max) * 24}`).join(" ");
  return (
    <svg viewBox="0 0 96 32" className={cx("h-8 w-24", className)} fill="none" aria-hidden>
      <polyline points={d} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-edge bg-ink-800 px-1 font-mono text-[10px] text-fog-400">
      {children}
    </kbd>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded-lg bg-ink-700", className)} />;
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span aria-hidden className="grid size-11 place-items-center rounded-2xl border border-dashed border-edge bg-ink-800 font-mono text-lg text-fog-500">
        ◌
      </span>
      <p className="mt-3 text-sm font-semibold text-fog-100">{title}</p>
      <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-fog-500">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
