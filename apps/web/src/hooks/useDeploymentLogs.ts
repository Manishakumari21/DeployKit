import { useEffect, useRef, useState } from "react";
import { fetchDeployment, fetchDeploymentLogs, type DeploymentLog } from "../lib/api";
import { isTerminalStatus } from "../types";

export function useDeploymentLogs(
  deploymentId: string | null,
  filters: { source?: string; level?: string } = {},
) {
  const [logs, setLogs] = useState<DeploymentLog[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);
  const filterKey = `${filters.source ?? ""}|${filters.level ?? ""}`;

  useEffect(() => {
    let alive = true;
    let stopped = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let cursor: string | null = null;
    let initialized = false;
    let isTerminal = false;

    queueMicrotask(() => {
      if (!alive) return;
      setLogs([]);
      setTruncated(false);
      setError(null);
      failures.current = 0;
    });

    if (!deploymentId) {
      return () => {
        alive = false;
        stopped = true;
      };
    }

    const tick = async () => {
      if (!alive || stopped || inFlight) return;
      inFlight = true;
      if (!initialized) setLoading(true);
      try {
        if (!isTerminal) {
          try {
            const dep = await fetchDeployment(deploymentId, abort.signal);
            if (isTerminalStatus(dep.status)) {
              isTerminal = true;
            }
          } catch {
            // Non-fatal if fetchDeployment fails; continue fetching logs
          }
        }

        const [source, level] = filterKey.split("|");
        const res = await fetchDeploymentLogs(
          deploymentId,
          {
            cursor,
            limit: 200,
            direction: "asc",
            ...(source ? { source } : {}),
            ...(level ? { level } : {}),
          },
          abort.signal,
        );
        if (!alive || stopped) return;
        failures.current = 0;
        setError(null);
        if (res.items.length > 0) {
          cursor = res.next_cursor ?? res.items[res.items.length - 1].id;
          setLogs((prev) => {
            const seen = new Set(prev.map((l) => l.id));
            const next = [...prev];
            for (const item of res.items) {
              if (!seen.has(item.id)) {
                seen.add(item.id);
                next.push(item);
              }
            }

            return next.length > 500 ? next.slice(next.length - 500) : next;
          });
        } else if (res.next_cursor) {
          cursor = res.next_cursor;
        }
        if (res.truncated) setTruncated(true);
        initialized = true;

        if (isTerminal && res.items.length < 200) {
          stopped = true;
          return;
        }
      } catch (e) {
        if (!alive || stopped || (e instanceof DOMException && e.name === "AbortError")) return;
        failures.current += 1;
        if (failures.current >= 3) {
          setError(e instanceof Error ? e.message : "Lost connection to API");
        }
      } finally {
        inFlight = false;
        if (alive && !stopped) {
          if (!initialized) setLoading(false);
          timer = setTimeout(tick, isTerminal ? 50 : 3000);
        } else if (alive && stopped) {
          setLoading(false);
        }
      }
    };

    void tick();
    return () => {
      alive = false;
      stopped = true;
      abort.abort();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
  }, [deploymentId, filterKey]);

  return { logs, truncated, loading, error };
}
