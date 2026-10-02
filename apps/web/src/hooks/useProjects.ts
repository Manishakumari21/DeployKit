import { useCallback, useEffect, useState } from "react";
import {
  checkHealth,
  createProject,
  deleteProject,
  fetchProjects,
} from "../lib/api";
import type { Project } from "../types";

export function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast ]);
  return { toast, setToast };
}

export function useProjects(notify: (m: string) => void) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (first = false) => {
      first ? setLoading(true) : setRefreshing(true);
      try {
        const [list, ok] = await Promise.all([fetchProjects(), checkHealth()]);
        setProjects(list);
        setHealthy(ok);
      } catch {
        notify("Could not reach the API");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    load(true);
  }, [load]);

  const remove = useCallback(async (id: string) => {
    await deleteProject(id);
    setProjects((p) => p.filter((x) => x.id !== id));
  }, []);

  const add = useCallback(
    async (name: string, repo: string, branch: string) => {
      const created = await createProject({
        name: name.trim(),
        repositoryUrl: repo.trim(),
        branch: branch.trim() || "main",
      });
      await load();
      return created;
    },
    [load]
  );

  return { projects, healthy, loading, refreshing, load, remove, add };
}
