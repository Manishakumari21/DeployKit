import { useEffect, useState } from "react";
import { fetchProjectMetrics, type ProjectMetrics } from "../lib/api";
import { Eyebrow, Panel, PanelHead, Skeleton, Spark } from "./ui";

function fmtDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function MetricsPanel({ projectId }: { projectId: string | null }) {
  const [metrics, setMetrics] = useState<ProjectMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      return;
    }
    let alive = true;
    const abort = new AbortController();
    fetchProjectMetrics(projectId, abort.signal)
      .then((m) => {
        if (alive) setMetrics(m);
      })
      .catch((e) => {
        if (alive && !(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof Error ? e.message : "Failed to load metrics");
        }
      });
    return () => {
      alive = false;
      abort.abort();
    };
  }, [projectId]);

  if (!projectId) return null;
  return (
    <Panel>
      <PanelHead title="Signal board" right={<span className="font-mono text-[11px] text-fog-500">sampled</span>} />
      {error && <p className="p-4 text-[13px] text-red-300">{error}</p>}
      {!error && !metrics && (
        <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      )}
      {metrics && (
        <div className="grid grid-cols-2 divide-edge/70 p-4 sm:grid-cols-4 sm:divide-x">
          <Stat
            label="Flights"
            value={String(metrics.deployments.total)}
            sub={`${metrics.deployments.successful} live · ${metrics.deployments.failed} lost`}
          />
          <Stat
            label="Success rate"
            value={metrics.deployments.success_rate === null ? "—" : `${Math.round(metrics.deployments.success_rate * 100)}%`}
            sub={`avg ${fmtDuration(metrics.deployments.avg_duration_seconds)} per flight`}
            accent
          />
          <Stat
            label="Queue"
            value={`${metrics.queue.queued + metrics.queue.running}`}
            sub={`${metrics.queue.queued} waiting · ${metrics.queue.running} running · ${metrics.queue.total_retries} retries`}
          />
          <Stat
            label="Fleet"
            value={String(metrics.runtime.active_releases)}
            sub={`${metrics.runtime.healthy_runtimes} healthy · worker ${metrics.worker.enabled ? "on shift" : "idle"}`}
          />
        </div>
      )}
      {metrics && metrics.deployments.total > 0 && (
        <div className="flex items-center gap-3 border-t border-edge px-4 py-2.5 text-fog-500">
          <Spark
            className="text-signal-400"
            points={sparkPoints(metrics)}
          />
          <p className="font-mono text-[11px]">
            {metrics.deployments.build_count} builds · {metrics.deployments.build_failures} build failures
          </p>
        </div>
      )}
    </Panel>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className="px-1 py-1 sm:px-4 sm:first:pl-0 sm:last:pr-0">
      <Eyebrow>{label}</Eyebrow>
      <p className={`mt-1 font-mono text-[26px] leading-none font-semibold tracking-tight tabular ${accent ? "text-signal-300" : "text-white"}`}>
        {value}
      </p>
      <p className="mt-1.5 font-mono text-[11px] text-fog-500">{sub}</p>
    </div>
  );
}

function sparkPoints(m: ProjectMetrics): number[] {
  const d = m.deployments;
  return [d.total, d.successful + 1, d.successful, d.total, d.successful + d.cancelled, d.total, d.successful + 1];
}
