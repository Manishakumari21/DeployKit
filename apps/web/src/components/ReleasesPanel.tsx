import { useCallback, useEffect, useState } from "react";
import { timeAgo } from "../lib/format";
import { fetchReleases, rollbackDeployment } from "../lib/api";
import type { Release } from "../types";
import { EmptyState, Panel, PanelHead, QuietBtn, Skeleton } from "./ui";

function shortDigest(digest: string): string {
  const hex = digest.replace(/^sha256:/, "");
  return `sha256:${hex.slice(0, 12)}…`;
}

function statusTone(status: Release["status"]): string {
  switch (status) {
    case "active":
      return "bg-signal-400/15 text-signal-300 ring-signal-400/40";
    case "healthy":
      return "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30";
    case "failed":
      return "bg-red-400/10 text-red-300 ring-red-400/40";
    case "stopped":
      return "bg-ink-700 text-fog-300 ring-edge";
    default:
      return "bg-amber-300/10 text-amber-200 ring-amber-300/30";
  }
}

function ReleaseRow({
  release,
  activeDeploymentBusy,
  rollingBackTo,
  confirmId,
  onAskConfirm,
  onCancelConfirm,
  onRollback,
}: {
  release: Release;
  activeDeploymentBusy: boolean;
  rollingBackTo: string | null;
  confirmId: string | null;
  onAskConfirm: (id: string) => void;
  onCancelConfirm: () => void;
  onRollback: (id: string) => void;
}) {
  // A failed release is not a valid rollback target (the API rejects it).
  const eligible = release.status !== "failed";
  const isRollingBack = rollingBackTo === release.id;
  const confirming = confirmId === release.id;

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[11px] ring-1 ${statusTone(release.status)}`}
      >
        {release.status}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[12px] text-fog-100" title={release.image_digest}>
          {shortDigest(release.image_digest)}
        </p>
        <p className="mt-0.5 font-mono text-[11px] text-fog-500 tabular">
          {timeAgo(release.created_at)}
          {release.supersedes_release_id ? " · supersedes prior" : ""}
        </p>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2">
          <button
            onClick={() => onRollback(release.id)}
            disabled={activeDeploymentBusy || isRollingBack}
            className="cursor-pointer rounded-lg bg-red-500/90 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-red-500 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRollingBack ? "Rolling back…" : "Confirm rollback"}
          </button>
          <button
            onClick={onCancelConfirm}
            className="cursor-pointer rounded-lg border border-edge px-3 py-1.5 text-[12px] text-fog-200 transition hover:border-fog-500"
          >
            Cancel
          </button>
        </div>
      ) : (
        <QuietBtn
          onClick={() => onAskConfirm(release.id)}
          disabled={!eligible || activeDeploymentBusy}
          title={eligible ? "Roll back to this release" : "Cannot roll back to a failed release"}
        >
          Roll back
        </QuietBtn>
      )}
    </li>
  );
}

export function ReleasesPanel({
  projectId,
  activeDeploymentBusy,
  onRollbackStarted,
}: {
  projectId: string | null;
  activeDeploymentBusy: boolean;
  onRollbackStarted: () => void;
}) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rollingBackTo, setRollingBackTo] = useState<string | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setReleases([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setReleases(await fetchReleases(projectId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load releases");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setConfirmId(null);
    setRollbackError(null);
    load();
  }, [load]);

  const handleRollback = async (releaseId: string) => {
    if (!projectId) return;
    setRollingBackTo(releaseId);
    setRollbackError(null);
    try {
      await rollbackDeployment(projectId, releaseId, crypto.randomUUID());
      setConfirmId(null);
      onRollbackStarted();
      await load();
    } catch (e) {
      setRollbackError(e instanceof Error ? e.message : "Rollback failed");
      setConfirmId(null);
    } finally {
      setRollingBackTo(null);
    }
  };

  if (!projectId) return null;

  return (
    <Panel>
      <PanelHead
        title="Releases"
        right={
          <button
            onClick={load}
            disabled={loading}
            className="cursor-pointer font-mono text-[11px] text-fog-400 transition hover:text-fog-200 disabled:opacity-50"
          >
            {loading ? "loading…" : "refresh"}
          </button>
        }
      />
      {loading && releases.length === 0 && (
        <div className="flex flex-col gap-2 p-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      )}
      {!loading && error && (
        <div className="p-6 text-center text-[13px]">
          <p className="text-red-300">{error}</p>
          <button
            onClick={load}
            className="mt-2 cursor-pointer rounded-lg border border-edge px-3 py-1.5 text-fog-200 transition hover:border-fog-500"
          >
            Retry
          </button>
        </div>
      )}
      {!loading && !error && releases.length === 0 && (
        <EmptyState
          title="No releases yet"
          body="A release is created when a deployment reaches the runtime. Deploy once to build up a rollback history."
        />
      )}
      {!error && releases.length > 0 && (
        <>
          {rollbackError && (
            <p className="border-t border-red-900/50 bg-red-950/30 px-4 py-2.5 text-[12px] text-red-300">{rollbackError}</p>
          )}
          <ul className="divide-y divide-edge/70">
            {releases.map((r) => (
              <ReleaseRow
                key={r.id}
                release={r}
                activeDeploymentBusy={activeDeploymentBusy}
                rollingBackTo={rollingBackTo}
                confirmId={confirmId}
                onAskConfirm={setConfirmId}
                onCancelConfirm={() => setConfirmId(null)}
                onRollback={handleRollback}
              />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
