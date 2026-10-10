import { useEffect, useState } from "react";
import { timeAgo } from "../lib/format";
import { cancelDeployment as apiCancelDeployment } from "../lib/api";
import { isCancellableStatus, type ApiDeployment, type DeploymentEvent } from "../types";
import { useDeploymentMonitor } from "../hooks/useDeployments";
import { DangerBtn, EmptyState, Panel, PanelHead, Skeleton, StatusPill } from "./ui";
import { PipelineRibbon } from "./PipelineRibbon";
import { cx } from "../lib/format";

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
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-signal-400 px-3.5 py-2 text-[13px] font-semibold text-ink-950 transition duration-200 hover:bg-signal-300 active:translate-y-px active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {creating ? "Deploying…" : "▸ Deploy"}
    </button>
  );
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

const STAGE_ORDER = ["queued", "cloning", "building", "pushing", "verifying", "deploying", "active"] as const;

function stageProgress(status: ApiDeployment["status"]): number {
  const i = STAGE_ORDER.indexOf(status as (typeof STAGE_ORDER)[number]);
  if (status === "active") return 100;
  if (i < 0) return 0;
  return Math.round(((i + 1) / STAGE_ORDER.length) * 100);
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
  const live = isCancellableStatus(deployment.status);
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        "block w-full cursor-pointer px-4 py-3 text-left transition duration-200",
        selected ? "bg-signal-950/40" : "hover:bg-ink-800/60"
      )}
    >
      <span className="flex flex-wrap items-center gap-2">
        <StatusPill status={deployment.status} />
        <span className="font-mono text-[11px] text-fog-500">
          {shortSha(deployment.commit_sha)} · {deployment.branch} · {deployment.trigger}
        </span>
        <span className="ml-auto font-mono text-[11px] text-fog-500 tabular">{timeAgo(deployment.created_at)}</span>
      </span>
      <span aria-hidden className="mt-2 block h-1 overflow-hidden rounded-full bg-ink-700">
        <span
          className={cx(
            "block h-full rounded-full transition-[width] duration-500",
            deployment.status === "failed" && "bg-red-400",
            deployment.status === "active" && "bg-signal-400",
            live && "bg-amber-300",
            deployment.status === "queued" && "bg-fog-500",
            deployment.status === "cancelled" && "bg-fog-500"
          )}
          style={{ width: `${deployment.status === "failed" || deployment.status === "cancelled" ? 100 : stageProgress(deployment.status)}%` }}
        />
      </span>
      {deployment.status === "failed" && deployment.error_message && (
        <span className="mt-1.5 block truncate text-[12px] text-red-300">{deployment.error_message}</span>
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
        title="Flight queue"
        right={<span className="font-mono text-[11px] text-fog-500 tabular">{deployments.length} deploys</span>}
      />
      {loading && (
        <div className="flex flex-col gap-2 p-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      )}
      {!loading && error && (
        <div className="p-6 text-center text-[13px]">
          <p className="text-red-300">{error}</p>
          <button onClick={onRetry} className="mt-2 cursor-pointer rounded-lg border border-edge px-3 py-1.5 text-fog-200 transition hover:border-fog-500">
            Retry
          </button>
        </div>
      )}
      {!loading && !error && deployments.length === 0 && (
        <EmptyState
          title="Pad is clear"
          body="No deployments yet. Launch one and watch it ride the rail from queue to live."
        />
      )}
      {!loading && !error && deployments.length > 0 && (
        <div className="divide-y divide-edge/70">
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
                stageFailed ? "bg-red-400" : current ? "animate-pulse bg-amber-300" : done ? "bg-signal-400" : "bg-ink-700"
              }`}
            />
            <span className={`capitalize ${current || stageFailed ? "font-semibold text-fog-100" : done ? "text-fog-200" : "text-fog-500"}`}>
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
  if (!deployment) return <Panel><p className="p-6 text-center text-[13px] text-fog-500">Locking onto deployment…</p></Panel>;

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
      <Panel className={deployment.status === "active" ? "dk-glow-signal" : undefined}>
        <PanelHead
          title={`Flight ${deployment.id.slice(0, 8)}`}
          right={<StatusPill status={deployment.status} />}
        />
        <PipelineRibbon deployment={deployment} events={events} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-edge px-4 py-3 font-mono text-[12px]">
          <dt className="text-fog-500">branch</dt><dd className="truncate text-fog-100">{deployment.branch}</dd>
          <dt className="text-fog-500">commit</dt><dd className="truncate text-fog-100 tabular">{deployment.commit_sha ?? "—"}</dd>
          <dt className="text-fog-500">trigger</dt><dd className="truncate text-fog-100">{deployment.trigger}</dd>
          <dt className="text-fog-500">launched</dt><dd className="truncate text-fog-100 tabular">{timeAgo(deployment.created_at)}</dd>
          <dt className="text-fog-500">lifted</dt><dd className="truncate text-fog-100 tabular">{deployment.started_at ? timeAgo(deployment.started_at) : "—"}</dd>
          <dt className="text-fog-500">touched down</dt><dd className="truncate text-fog-100 tabular">{deployment.finished_at ? timeAgo(deployment.finished_at) : "—"}</dd>
          {deployment.job_status && (<><dt className="text-fog-500">worker job</dt><dd className="truncate text-fog-100 tabular">{deployment.job_status} · try {deployment.job_attempts}/{deployment.max_attempts}</dd></>)}
          {deployment.image_digest && (<><dt className="text-fog-500">digest</dt><dd className="truncate text-signal-300 tabular">{deployment.image_digest.slice(0, 19)}…</dd></>)}
        </dl>
        {deployment.status === "failed" && (
          <div className="border-t border-red-900/50 bg-red-950/30 p-4 text-[13px]">
            <p className="font-mono font-semibold text-red-300">{deployment.error_code ?? "Failed"}</p>
            {deployment.error_message && <p className="mt-1 break-words text-fog-200">{deployment.error_message}</p>}
          </div>
        )}
        {cancellable && (
          <div className="border-t border-edge p-4">
            <DangerBtn onClick={doCancel} disabled={cancelling}>
              {cancelling ? "Aborting…" : "Abort flight"}
            </DangerBtn>
            {cancelError && <p className="mt-2 text-[12px] text-red-300">{cancelError}</p>}
          </div>
        )}
      </Panel>
      <Panel>
        <PanelHead title="Flight recorder" right={<span className="font-mono text-[11px] text-fog-500 tabular">{events.length}</span>} />
        {events.length === 0 ? (
          <p className="p-4 text-[13px] text-fog-500">No events on the recorder yet.</p>
        ) : (
          <ul className="divide-y divide-edge/70">
            {events.map((e) => (
              <li key={e.id} className="px-4 py-2.5 text-[13px]">
                <p className="text-fog-200">{e.message ?? e.event_type}</p>
                <p className="mt-0.5 font-mono text-[11px] text-fog-500">
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
  }, [status, updatedAt]);
}
