import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelDeployment as apiCancel,
  createDeployment as apiCreate,
  fetchDeployment,
  fetchDeploymentEvents,
  fetchDeployments,
} from "../lib/api";
import {
  isTerminalStatus,
  type ApiDeployment,
  type DeploymentEvent,
} from "../types";

export function useDeployments(projectId: string | null) {
  const [deployments, setDeployments] = useState<ApiDeployment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!projectId) {
      setDeployments([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      setDeployments(await fetchDeployments(projectId));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load deployments",
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    queueMicrotask(() => {
      void reload();
    });
  }, [reload]);

  const create = useCallback(async () => {
    if (!projectId || creating) return null;

    const key = crypto.randomUUID();

    setCreating(true);
    setCreateError(null);

    try {
      const d = await apiCreate(projectId, key);

      setDeployments((prev) => [
        d,
        ...prev.filter((x) => x.id !== d.id),
      ]);

      return d;
    } catch (e) {
      setCreateError(
        e instanceof Error
          ? e.message
          : "Failed to create deployment",
      );
      return null;
    } finally {
      setCreating(false);
    }
  }, [projectId, creating]);

  const cancel = useCallback(async (deploymentId: string) => {
    const updated = await apiCancel(deploymentId);

    setDeployments((prev) =>
      prev.map((d) =>
        d.id === deploymentId
          ? {
              ...d,
              status: updated.status as ApiDeployment["status"],
            }
          : d,
      ),
    );

    return updated;
  }, []);

  return {
    deployments,
    loading,
    error,
    reload,
    creating,
    createError,
    create,
    cancel,
    setDeployments,
  };
}

export function useDeploymentMonitor(deploymentId: string | null) {
  const [deployment, setDeployment] =
    useState<ApiDeployment | null>(null);
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    let alive = true;

    queueMicrotask(() => {
      if (!alive) return;

      setDeployment(null);
      setEvents([]);
      setError(null);
      failures.current = 0;
    });

    if (!deploymentId) {
      return () => {
        alive = false;
      };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let lastUpdatedAt: string | null = null;

    const abort = new AbortController();

    const tick = async () => {
      if (!alive || inFlight) return;

      inFlight = true;

      try {
        const d = await fetchDeployment(
          deploymentId,
          abort.signal,
        );

        if (!alive) return;

        failures.current = 0;

        setDeployment((prev) =>
          prev &&
          prev.updated_at === d.updated_at &&
          prev.status === d.status
            ? prev
            : d,
        );

        if (d.updated_at !== lastUpdatedAt) {
          lastUpdatedAt = d.updated_at;

          try {
            const ev = await fetchDeploymentEvents(
              deploymentId,
            );

            if (alive) {
              setEvents(ev);
            }
          } catch {
            // Events are supplementary; keep the last known list.
          }
        }

        if (isTerminalStatus(d.status)) {
          return;
        }
      } catch (e) {
        if (
          !alive ||
          (e instanceof DOMException && e.name === "AbortError")
        ) {
          return;
        }

        failures.current += 1;

        if (failures.current >= 5) {
          setError(
            e instanceof Error
              ? e.message
              : "Lost connection to API",
          );
        }
      } finally {
        inFlight = false;

        if (alive) {
          timer = setTimeout(tick, 2000);
        }
      }
    };

    void tick();

    return () => {
      alive = false;
      abort.abort();

      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [deploymentId]);

  return { deployment, events, error };
}