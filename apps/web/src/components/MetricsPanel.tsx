import { useEffect, useState } from "react";
import { fetchProjectMetrics, type ProjectMetrics } from "../lib/api";
import { Panel, PanelHead } from "./ui";

function fmtDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// Real sampled metrics from GET /api/projects/:id/metrics (polled, not real-time).
export function MetricsPanel({ projectId }: { projectId: string | null }) {
  const [metrics, setMetrics] = useState<ProjectMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setMetrics(null);
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
      <PanelHead title="Metrics" right={<span className="font-mono text-[11px] text-zinc-600">sampled</span>} />
      {error && <p className="p-4 text-[13px] text-red-300">{error}</p>}
      {!error && !metrics && <p className="p-4 text-[13px] text-zinc-500">Loading metrics…</p>}
      {metrics && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 font-mono text-[12px] sm:grid-cols-4">
          <div><dt className="text-zinc-500">deployments</dt><dd className="text-zinc-100">{metrics.deployments.total}</dd></div>
          <div><dt className="text-zinc-500">success</dt><dd className="text-emerald-300">{metrics.deployments.successful}</dd></div>
          <div><dt className="text-zinc-500">failed</dt><dd className="text-red-300">{metrics.deployments.failed}</dd></div>
          <div><dt className="text-zinc-500">success rate</dt><dd className="text-zinc-100">{metrics.deployments.success_rate === null ? "—" : `${Math.round(metrics.deployments.success_rate * 100)}%`}</dd></div>
          <div><dt className="text-zinc-500">avg duration</dt><dd className="text-zinc-100">{fmtDuration(metrics.deployments.avg_duration_seconds)}</dd></div>
          <div><dt className="text-zinc-500">queue</dt><dd className="text-zinc-100">{metrics.queue.queued} queued · {metrics.queue.running} running</dd></div>
          <div><dt className="text-zinc-500">active releases</dt><dd className="text-zinc-100">{metrics.runtime.active_releases}</dd></div>
          <div><dt className="text-zinc-500">worker</dt><dd className="text-zinc-100">{metrics.worker.enabled ? "enabled" : "idle"}</dd></div>
        </dl>
      )}
    </Panel>
  );
}
