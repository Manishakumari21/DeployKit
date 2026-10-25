import { AlertTriangle, CheckCircle2, Eye, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  acknowledgeIncident,
  ApiError,
  fetchIncidents,
  resolveIncident,
} from "../lib/api";
import { cx, timeAgo } from "../lib/format";
import type {
  Incident,
  IncidentKind,
  IncidentStatusFilter,
  Project,
} from "../types";
import { EmptyState, Eyebrow, Panel, PanelHead, QuietBtn, Skeleton } from "./ui";

const KIND_LABELS: Record<IncidentKind, string> = {
  deployment_failure: "Deployment failed",
  runtime_unhealthy: "Runtime unhealthy",
  gateway_sync_failed: "Gateway sync failed",
  tls_failure: "TLS problem",
  webhook_failed: "Webhook failed",
};

const STATUS_FILTERS: { key: IncidentStatusFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "open", label: "Open" },
  { key: "acknowledged", label: "Acknowledged" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];

function SeverityPill({ severity }: { severity: "warning" | "critical" }) {
  const critical = severity === "critical";
  return (
    <span
      className={cx(
        "rounded-full px-2 py-0.5 font-mono text-[11px]",
        critical
          ? "border border-red-500/40 bg-red-500/10 text-red-300"
          : "border border-amber-500/40 bg-amber-500/10 text-amber-300"
      )}
    >
      {critical ? "critical" : "warning"}
    </span>
  );
}

function StatusBadge({ incident }: { incident: Incident }) {
  const label =
    incident.status === "open"
      ? "open"
      : incident.status === "acknowledged"
        ? "acknowledged"
        : `resolved · ${incident.resolution ?? "manual"}`;
  const tone =
    incident.status === "resolved"
      ? "border-edge bg-ink-950 text-fog-400"
      : incident.status === "acknowledged"
        ? "border-signal-500/40 bg-signal-500/10 text-signal-300"
        : "border-red-500/40 bg-red-500/10 text-red-300";
  return (
    <span className={cx("rounded-full border px-2 py-0.5 font-mono text-[11px]", tone)}>
      {label}
    </span>
  );
}

export function IncidentsView({
  projects,
  selectedProjectId,
  onSelectProject,
}: {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
}) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [status, setStatus] = useState<IncidentStatusFilter>("active");
  const [loading, setLoading] = useState(Boolean(selectedProjectId));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(
    (signal?: AbortSignal): Promise<void> => {
      if (!selectedProjectId) return Promise.resolve();
      const requestId = ++requestRef.current;
      return fetchIncidents(selectedProjectId, { status, limit: 100 }, signal)
        .then((data) => {
          if (requestRef.current === requestId) {
            setError(null);
            setIncidents(data);
          }
        })
        .catch((loadError: unknown) => {
          if (requestRef.current === requestId) {
            if (loadError instanceof ApiError && loadError.status === 403) {
              setError("You do not have access to this project.");
            } else {
              setError(loadError instanceof Error ? loadError.message : "Failed to load incidents");
            }
          }
        })
        .finally(() => {
          if (requestRef.current === requestId) {
            setLoading(false);
            setRefreshing(false);
          }
        });
    },
    [selectedProjectId, status]
  );

  useEffect(() => {
    if (!selectedProjectId) {
      requestRef.current += 1;
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      requestRef.current += 1;
    };
  }, [load, selectedProjectId]);

  const refresh = async () => {
    if (!selectedProjectId) return;
    setRefreshing(true);
    await load();
  };

  const runAction = async (
    incident: Incident,
    action: "acknowledge" | "resolve"
  ) => {
    if (!selectedProjectId) return;
    setBusyId(incident.id);
    try {
      const updated =
        action === "acknowledge"
          ? await acknowledgeIncident(selectedProjectId, incident.id)
          : await resolveIncident(selectedProjectId, incident.id);
      setIncidents((current) =>
        current.map((entry) => (entry.id === updated.id ? updated : entry))
      );
      setError(null);
    } catch (actionError) {
      if (actionError instanceof ApiError && actionError.status === 409) {
        // State moved under us (e.g. the sweep resolved it): refresh the list.
        setError(null);
        await load();
      } else if (actionError instanceof ApiError && actionError.status === 404) {
        setError(null);
        await load();
      } else {
        setError(
          actionError instanceof Error ? actionError.message : "Action failed"
        );
      }
    } finally {
      setBusyId(null);
    }
  };

  const selectClass =
    "rounded-lg border border-edge bg-ink-900 px-3 py-2 text-[13px] text-fog-100 outline-none focus:border-signal-500 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className="dk-stagger flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Observability</Eyebrow>
          <h1 className="mt-1 text-xl font-bold tracking-tight text-white">Incidents</h1>
          <p className="mt-1 text-[13px] text-fog-500">
            Failure signals grouped per subject: deployments, runtimes, gateway sync, TLS and webhooks.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[12px] text-fog-500">
            Service
            <select
              aria-label="Service"
              value={selectedProjectId ?? ""}
              onChange={(event) => {
                if (event.target.value) onSelectProject(event.target.value);
              }}
              disabled={projects.length === 0}
              className={selectClass}
            >
              {!selectedProjectId && <option value="">Choose a service</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <QuietBtn
            onClick={refresh}
            disabled={!selectedProjectId || loading || refreshing}
            aria-label="Refresh incidents"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin-slower" : ""} />
            <span className="hidden sm:inline">Refresh</span>
          </QuietBtn>
        </div>
      </div>

      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Incident status">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.key}
            role="tab"
            aria-selected={status === filter.key}
            onClick={() => setStatus(filter.key)}
            className={cx(
              "rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
              status === filter.key
                ? "bg-signal-500/15 text-signal-300 ring-1 ring-signal-500/40"
                : "text-fog-400 hover:bg-ink-800 hover:text-fog-200"
            )}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <Panel>
        <PanelHead
          title="Incidents"
          right={
            <span className="font-mono text-[11px] text-fog-500 tabular">
              {selectedProjectId ? incidents.length : 0}{" "}
              {(selectedProjectId ? incidents.length : 0) === 1 ? "incident" : "incidents"}
            </span>
          }
        />
        {!selectedProjectId && (
          <EmptyState
            title="No service selected"
            body="Choose a service to inspect its incidents."
          />
        )}
        {selectedProjectId && loading && (
          <div className="flex flex-col gap-2 p-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-16" />
            ))}
          </div>
        )}
        {selectedProjectId && !loading && error && (
          <div className="p-6 text-center text-[13px]">
            <p role="alert" className="text-red-300">
              {error}
            </p>
            <QuietBtn onClick={refresh} className="mt-3">
              Retry
            </QuietBtn>
          </div>
        )}
        {selectedProjectId && !loading && !error && incidents.length === 0 && (
          <EmptyState
            title="No incidents"
            body="No failure signals match this filter. Detected failures appear here as they are found."
          />
        )}
        {selectedProjectId && !loading && !error && incidents.length > 0 && (
          <ul className="divide-y divide-edge/70">
            {incidents.map((incident) => (
              <li key={incident.id} className="px-4 py-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityPill severity={incident.severity} />
                  <span className="rounded-full border border-edge bg-ink-950 px-2 py-0.5 font-mono text-[11px] text-fog-400">
                    {KIND_LABELS[incident.kind] ?? incident.kind}
                  </span>
                  <StatusBadge incident={incident} />
                  <span className="min-w-0 break-words font-medium text-fog-100">
                    {incident.title}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-fog-500 tabular">
                    {incident.occurrence_count > 1
                      ? `×${incident.occurrence_count} · `
                      : ""}
                    {timeAgo(incident.last_seen_at)}
                  </span>
                </div>
                {incident.detail && (
                  <p className="mt-1 break-words text-[12px] text-fog-400">{incident.detail}</p>
                )}
                <p className="mt-1 break-words font-mono text-[11px] text-fog-500">
                  {incident.error_code ? `${incident.error_code} · ` : ""}
                  {incident.subject_key} · first seen {timeAgo(incident.first_seen_at)}
                </p>
                {incident.status !== "resolved" && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {incident.status === "open" && (
                      <QuietBtn
                        onClick={() => void runAction(incident, "acknowledge")}
                        disabled={busyId === incident.id}
                        aria-label={`Acknowledge incident ${incident.title}`}
                      >
                        <Eye size={13} />
                        Acknowledge
                      </QuietBtn>
                    )}
                    <QuietBtn
                      onClick={() => void runAction(incident, "resolve")}
                      disabled={busyId === incident.id}
                      aria-label={`Resolve incident ${incident.title}`}
                    >
                      <CheckCircle2 size={13} />
                      Resolve
                    </QuietBtn>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {selectedProjectId && !loading && incidents.some((i) => i.severity === "critical") && (
        <p className="flex items-center gap-2 text-[12px] text-fog-500">
          <AlertTriangle size={13} className="text-red-300" />
          Critical incidents indicate a service that is not currently serving traffic correctly.
        </p>
      )}
    </div>
  );
}
