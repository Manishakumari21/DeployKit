import { useEffect, useRef, useState } from "react";
import { fetchDeploymentLogs, type DeploymentLog } from "../lib/api";

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
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let cursor: string | null = null;
    let initialized = false;

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
      };
    }

    const tick = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      if (!initialized) setLoading(true);
      try {
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
        if (!alive) return;
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
      } catch (e) {
        if (!alive || (e instanceof DOMException && e.name === "AbortError")) return;
        failures.current += 1;
        if (failures.current >= 3) {
          setError(e instanceof Error ? e.message : "Lost connection to API");
        }
      } finally {
        inFlight = false;
        if (alive) {
          if (!initialized) setLoading(false);
          timer = setTimeout(tick, 3000);
        }
      }
    };

    void tick();
    return () => {
      alive = false;
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [deploymentId, filterKey]);

  return { logs, truncated, loading, error };
}
