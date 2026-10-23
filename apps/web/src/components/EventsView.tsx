import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchProjectEvents } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Project, ProjectEvent } from "../types";
import { EmptyState, Eyebrow, Panel, PanelHead, QuietBtn, Skeleton, StatusPill } from "./ui";

export function EventsView({
  projects,
  selectedProjectId,
  onSelectProject,
}: {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
}) {
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [loading, setLoading] = useState(Boolean(selectedProjectId));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!selectedProjectId) {
      requestRef.current += 1;
      return;
    }
    const requestId = ++requestRef.current;
    fetchProjectEvents(selectedProjectId, 50)
      .then((data) => {
        if (requestRef.current === requestId) {
          setError(null);
          setEvents(data);
        }
      })
      .catch((loadError) => {
        if (requestRef.current === requestId) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load events");
        }
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
    return () => {
      requestRef.current += 1;
    };
  }, [selectedProjectId]);

  const refresh = async () => {
    if (!selectedProjectId) return;
    const requestId = ++requestRef.current;
    setRefreshing(true);
    setError(null);
    try {
      const data = await fetchProjectEvents(selectedProjectId, 50);
      if (requestRef.current === requestId) setEvents(data);
    } catch (loadError) {
      if (requestRef.current === requestId) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load events");
      }
    } finally {
      if (requestRef.current === requestId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const selectClass =
    "rounded-lg border border-edge bg-ink-900 px-3 py-2 text-[13px] text-fog-100 outline-none focus:border-signal-500 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <div className="dk-stagger flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Observability</Eyebrow>
          <h1 className="mt-1 text-xl font-bold tracking-tight text-white">Events</h1>
          <p className="mt-1 text-[13px] text-fog-500">
            Every state change across this service&apos;s flights, newest first.
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
            aria-label="Refresh events"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin-slower" : ""} />
            <span className="hidden sm:inline">Refresh</span>
          </QuietBtn>
        </div>
      </div>

      <Panel>
        <PanelHead
          title="Event stream"
          right={
            <span className="font-mono text-[11px] text-fog-500 tabular">
              {selectedProjectId ? events.length : 0}{" "}
              {(selectedProjectId ? events.length : 0) === 1 ? "event" : "events"}
            </span>
          }
        />
        {!selectedProjectId && (
          <EmptyState
            title="No service selected"
            body="Choose a service to inspect its event stream."
          />
        )}
        {selectedProjectId && loading && (
          <div className="flex flex-col gap-2 p-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-14" />
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
        {selectedProjectId && !loading && !error && events.length === 0 && (
          <EmptyState
            title="No events yet"
            body="Events appear here when this service starts a deployment or changes state."
          />
        )}
        {selectedProjectId && !loading && !error && events.length > 0 && (
          <ul className="divide-y divide-edge/70">
            {events.map((event) => (
              <li key={event.id} className="px-4 py-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  {event.status_to ? (
                    <StatusPill status={event.status_to} />
                  ) : (
                    <span className="rounded-full border border-edge bg-ink-950 px-2 py-0.5 font-mono text-[11px] text-fog-400">
                      {event.event_type}
                    </span>
                  )}
                  <span className="min-w-0 break-words text-fog-200">
                    {event.message ?? event.event_type}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-fog-500 tabular">
                    {timeAgo(event.created_at)}
                  </span>
                </div>
                <p className="mt-1 break-words font-mono text-[11px] text-fog-500">
                  {event.event_type} · flight {event.deployment_id.slice(0, 8)} · {event.branch}
                  {event.commit_sha ? ` · ${event.commit_sha.slice(0, 7)}` : ""} · {event.trigger}
                  {event.status_from || event.status_to
                    ? ` · ${event.status_from ?? "—"} → ${event.status_to ?? "—"}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
