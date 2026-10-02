import { useEffect, useState } from "react";
import { timeAgo } from "../lib/format";
import { cancelDeployment as apiCancelDeployment } from "../lib/api";
import { isCancellableStatus, type ApiDeployment, type DeploymentEvent } from "../types";
import { useDeploymentMonitor } from "../hooks/useDeployments";
import { Panel, PanelHead, StatusPill } from "./ui";

export function DeployButton({
  onDeploy,
  creating,
  disabled,
}: {
  onDeploy: () => void;
  creating: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onDeploy}
      disabled={disabled || creating}
      aria-label="Deploy project"
      className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3.5 py-2 text-[13px] font-semibold text-zinc-950 transition hover:bg-white disabled:opacity-50"
    >
      {creating ? "Deploying…" : "Deploy"}
    </button>
  );
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function DeploymentRow({
  deployment,
  selected,
  onSelect,
}: {
  deployment: ApiDeployment;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`block w-full px-4 py-2.5 text-left transition hover:bg-zinc-900/70 ${selected ? "bg-zinc-900/70" : ""}`}
    >
      <span className="flex flex-wrap items-center gap-2">
        <StatusPill status={deployment.status} />
        <span className="font-mono text-[11px] text-zinc-500">
          {shortSha(deployment.commit_sha)} · {deployment.branch} · {deployment.trigger}
        </span>
        <span className="ml-auto font-mono text-[11px] text-zinc-600">{timeAgo(deployment.created_at)}</span>
      </span>
      {deployment.status === "failed" && deployment.error_message && (
        <span className="mt-1 block truncate text-[12px] text-red-300">{deployment.error_message}</span>
      )}
    </button>
  );
}

export function DeploymentList({
  deployments,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  deployments: ApiDeployment[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  return (
    <Panel>
      <PanelHead
        title="Deployments"
        right={<span className="font-mono text-[11px] text-zinc-600">{deployments.length} deploys</span>}
      />
      {loading && <p className="p-6 text-center text-[13px] text-zinc-500">Loading deployments…</p>}
      {!loading && error && (
        <div className="p-6 text-center text-[13px]">
          <p className="text-red-300">{error}</p>
          <button onClick={onRetry} className="mt-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-zinc-200 hover:border-zinc-500">
            Retry
          </button>
        </div>
      )}
      {!loading && !error && deployments.length === 0 && (
        <p className="p-6 text-center text-[13px] text-zinc-500">No deployments yet — click Deploy to create one.</p>
      )}
      {!loading && !error && deployments.length > 0 && (
        <div className="divide-y divide-zinc-800/70">
          {deployments.map((d) => (
            <DeploymentRow key={d.id} deployment={d} selected={d.id === selectedId} onSelect={() => onSelect(d.id)} />
          ))}
        </div>
      )}
    </Panel>
  );
}

const STAGES = ["queued", "cloning", "building", "pushing", "verifying", "deploying", "active"] as const;

export function DeploymentTimeline({ deployment, events }: { deployment: ApiDeployment; events: DeploymentEvent[] }) {
  const seen = new Set<string>();
  for (const e of events) {
    if (e.status_to) seen.add(e.status_to);
  }
  seen.add(deployment.status);
  const failed = deployment.status === "failed";
  return (
    <ol className="flex flex-col gap-1 p-4">
      {STAGES.map((stage) => {
        const done = seen.has(stage) && (stage !== deployment.status || deployment.status === "active");
        const current = stage === deployment.status && !failed;
        const stageFailed = failed && stage === deployment.status;
        return (
          <li key={stage} className="flex items-center gap-2.5 text-[13px]">
            <span
              aria-hidden
              className={`size-2.5 rounded-full ${
                stageFailed ? "bg-red-400" : current ? "animate-pulse bg-amber-300" : done ? "bg-emerald-400" : "bg-zinc-700"
              }`}
            />
            <span className={`capitalize ${current || stageFailed ? "font-semibold text-zinc-100" : done ? "text-zinc-300" : "text-zinc-600"}`}>
              {stage}
              {current ? " — in progress" : stageFailed ? " — failed here" : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function DeploymentDetails({
  deploymentId,
  onUpdate,
}: {
  deploymentId: string;
  onUpdate: (d: ApiDeployment) => void;
}) {
  const { deployment, events, error } = useDeploymentMonitor(deploymentId);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffectSync(deployment, onUpdate);

  if (error && !deployment) return <Panel><p className="p-6 text-center text-[13px] text-red-300">{error}</p></Panel>;
  if (!deployment) return <Panel><p className="p-6 text-center text-[13px] text-zinc-500">Loading deployment…</p></Panel>;

  const cancellable = isCancellableStatus(deployment.status);

  const doCancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      const updated = await apiCancelDeployment(deploymentId);
      onUpdate({ ...deployment, status: updated.status as ApiDeployment["status"] });
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <PanelHead title="Deployment" right={<StatusPill status={deployment.status} />} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 font-mono text-[12px]">
          <dt className="text-zinc-500">status</dt><dd className="truncate text-zinc-100">{deployment.status}</dd>
          <dt className="text-zinc-500">branch</dt><dd className="truncate text-zinc-100">{deployment.branch}</dd>
          <dt className="text-zinc-500">commit</dt><dd className="truncate text-zinc-100">{deployment.commit_sha ?? "—"}</dd>
          <dt className="text-zinc-500">trigger</dt><dd className="truncate text-zinc-100">{deployment.trigger}</dd>
          <dt className="text-zinc-500">created</dt><dd className="truncate text-zinc-100">{timeAgo(deployment.created_at)}</dd>
          <dt className="text-zinc-500">started</dt><dd className="truncate text-zinc-100">{deployment.started_at ? timeAgo(deployment.started_at) : "—"}</dd>
          <dt className="text-zinc-500">finished</dt><dd className="truncate text-zinc-100">{deployment.finished_at ? timeAgo(deployment.finished_at) : "—"}</dd>
          {deployment.job_status && (<><dt className="text-zinc-500">job</dt><dd className="truncate text-zinc-100">{deployment.job_status} · attempt {deployment.job_attempts}/{deployment.max_attempts}</dd></>)}
        </dl>
        {deployment.status === "failed" && (
          <div className="border-t border-zinc-800 p-4 text-[13px]">
            <p className="font-semibold text-red-300">{deployment.error_code ?? "Failed"}</p>
            {deployment.error_message && <p className="mt-1 break-words text-zinc-300">{deployment.error_message}</p>}
          </div>
        )}
        {cancellable && (
          <div className="border-t border-zinc-800 p-4">
            <button
              onClick={doCancel}
              disabled={cancelling}
              className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[13px] font-semibold text-red-200 hover:bg-red-950 disabled:opacity-50"
            >
              {cancelling ? "Cancelling…" : "Cancel deployment"}
            </button>
            {cancelError && <p className="mt-2 text-[12px] text-red-300">{cancelError}</p>}
          </div>
        )}
      </Panel>
      <Panel>
        <PanelHead title="Timeline" />
        <DeploymentTimeline deployment={deployment} events={events} />
      </Panel>
      <Panel>
        <PanelHead title="Events" right={<span className="font-mono text-[11px] text-zinc-600">{events.length}</span>} />
        {events.length === 0 ? (
          <p className="p-4 text-[13px] text-zinc-500">No events yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {events.map((e) => (
              <li key={e.id} className="px-4 py-2.5 text-[13px]">
                <p className="text-zinc-200">{e.message ?? e.event_type}</p>
                <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
                  {e.event_type}
                  {e.status_from || e.status_to ? ` · ${e.status_from ?? "—"} → ${e.status_to ?? "—"}` : ""} · {timeAgo(e.created_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function useEffectSync(deployment: ApiDeployment | null, onUpdate: (d: ApiDeployment) => void) {
  const status = deployment?.status;
  const updatedAt = deployment?.updated_at;
  useEffect(() => {
    if (deployment) onUpdate(deployment);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, updatedAt]);
}
