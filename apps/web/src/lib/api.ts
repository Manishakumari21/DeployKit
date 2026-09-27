import type { Project } from "../types";

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://localhost:3000/api";

async function json(res: Response) {
  return res.json().catch(() => ({}));
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API_URL}/projects`);
  const data = await json(res);
  return Array.isArray(data) ? data : [];
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function createProject(input: {
  name: string;
  repositoryUrl: string;
  branch: string;
}): Promise<Project> {
  const res = await fetch(`${API_URL}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await json(res);
  if (!res.ok) throw new Error(data.error || "Failed to create project");
  return data as Project;
}

export async function deleteProject(id: string) {
  await fetch(`${API_URL}/projects/${id}`, { method: "DELETE" });
}
