import { Check } from "lucide-react";
import { cx } from "../lib/format";
import type { ApiDeployment, DeploymentEvent } from "../types";

const STAGES = [
  "queued",
  "cloning",
  "building",
  "pushing",
  "verifying",
  "deploying",
  "active",
] as const;

type Stage = (typeof STAGES)[number];

export function PipelineRibbon({
  deployment,
  events,
}: {
  deployment: ApiDeployment;
  events: DeploymentEvent[];
}) {
  const seen = new Set<string>();
  for (const e of events) {
    if (e.status_to) seen.add(e.status_to);
  }
  seen.add(deployment.status);

  const failed = deployment.status === "failed";
  const cancelled = deployment.status === "cancelled";
  const order = new Map<Stage, number>(STAGES.map((s, i) => [s, i]));
  const currentIdx = ["failed", "cancelled"].includes(deployment.status)
    ? (order.get(deployment.status as Stage) ?? STAGES.length)
    : (order.get(deployment.status as Stage) ?? 0);

  return (
    <ol className="flex items-stretch gap-0 overflow-x-auto px-4 py-3.5" aria-label="Deployment pipeline">
      {STAGES.map((stage, i) => {
        if (stage === "pushing" && !seen.has("pushing")) return null;
        const idx = order.get(stage)!;
        const done = failed || cancelled ? seen.has(stage) && idx < currentIdx : seen.has(stage) && (idx < currentIdx || deployment.status === "active");
        const current = !failed && !cancelled && stage === deployment.status;
        const halted = (failed || cancelled) && stage === deployment.status;
        const upcoming = !done && !current && !halted;
        const last = i === STAGES.length - 1;
        return (
          <li key={stage} className="flex min-w-0 flex-1 items-center last:flex-none">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="flex items-center gap-1.5">
                <span
                  className={cx(
                    "grid size-5 shrink-0 place-items-center rounded-full border font-mono text-[9px]",
                    done && "border-signal-400/50 bg-signal-950 text-signal-300",
                    current && "border-amber-300/60 bg-amber-300/10 text-amber-200",
                    halted && failed && "border-red-400/60 bg-red-950 text-red-300",
                    halted && cancelled && "border-edge bg-ink-700 text-fog-500",
                    upcoming && "border-edge bg-ink-800 text-fog-500"
                  )}
                >
                  {done ? <Check size={11} strokeWidth={3} /> : <span>{idx + 1}</span>}
                </span>
                <span
                  className={cx(
                    "truncate text-[12px]",
                    done && "font-medium text-fog-200",
                    current && "font-semibold text-white",
                    halted && failed && "font-semibold text-red-200",
                    halted && cancelled && "text-fog-500",
                    upcoming && "text-fog-500"
                  )}
                >
                  {stage}
                  {current && <span aria-hidden className="ml-1 inline-block animate-blink text-amber-300">▮</span>}
                </span>
              </span>
              <span
                aria-hidden
                className={cx(
                  "ml-2.5 h-1 w-10 rounded-full sm:w-14",
                  done && "bg-signal-500/70",
                  current && "relative overflow-hidden bg-ink-700",
                  halted && failed && "bg-red-500/70",
                  halted && cancelled && "bg-ink-700",
                  upcoming && "bg-ink-700"
                )}
              >
                {current && (
                  <span className="absolute inset-y-0 w-2/5 animate-sweep rounded-full bg-amber-300" />
                )}
              </span>
            </div>
            {!last && !(stage === "pushing" && !seen.has("pushing")) && (
              <span
                aria-hidden
                className={cx(
                  "mx-1.5 mt-0.5 hidden h-px w-4 shrink-0 sm:block",
                  done || current ? "bg-edge" : "bg-ink-700"
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
