import type { Deployment, Domain, Project } from "../types";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const MESSAGES = [
  "feat: add checkout flow",
  "fix: resolve memory leak in worker",
  "chore: bump dependencies",
  "feat: new landing hero",
  "fix: auth redirect loop",
  "perf: cache static assets",
  "feat: add webhook handler",
];

const AUTHORS = ["manisha", "dev-patel", "ci-bot", "sara-k", "alex-r"];

export function toDeployments(projects: Project[]): Deployment[] {
  return projects.flatMap((p, pi) => {
    const h = hash(p.id);
    const count = 1 + (h % 3); 
    return Array.from({ length: count }, (_, i) => {
      const n = hash(p.id + i);
      const status: Deployment["status"] =
        i === 0 && pi === 0 && projects.length > 0
          ? "building"
          : n % 9 === 0
            ? "failed"
            : n % 5 === 0
              ? "queued"
              : "ready";
      const mins = (n % 240) + 4;
      const env: Deployment["env"] = i === 0 ? "production" : "preview";
      return {
        id: `${p.id.slice(0, 8)}-${i}`,
        projectId: p.id,
        projectName: p.name,
        status,
        branch: i === 0 ? p.branch : n % 2 ? p.branch : "preview/ui-refresh",
        commit: n.toString(16).slice(0, 7).padStart(7, "a"),
        message: MESSAGES[n % MESSAGES.length],
        author: AUTHORS[n % AUTHORS.length],
        createdAt: new Date(Date.now() - mins * 60000 - pi * 3600000).toISOString(),
        duration: `${20 + (n % 90)}s`,
        env,
      };
    });
  }).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
}

export function toDomains(projects: Project[]): Domain[] {
  return projects.map((p, i) => ({
    host: `${p.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.deploykit.local`,
    projectName: p.name,
    ssl: true,
    primary: i === 0,
  }));
}

export function fakeMetrics(seed: string) {
  const h = hash(seed);
  return {
    cpu: 18 + (h % 55),
    ram: 30 + ((h >> 3) % 50),
    build: `${25 + (h % 80)}s`,
    uptime: `${99 + ((h % 90) / 100)}%`.slice(0, 5) + "%",
    spark: Array.from({ length: 16 }, (_, i) => 20 + ((hash(seed + i) >> 2) % 60)),
  };
}

export function fakeLogs(projectName: string): string[] {
  return [
    `$ dokploy deploy ${projectName} --prod`,
    "✓ resolved 148 packages in 2.1s",
    "✓ built client in 38.4s (vite v8)",
    "✓ image size 212MB → 168MB (layer cache hit)",
    "→ pushing to registry :3001 … done",
    "→ container healthy on :8080 (12ms p99)",
    `✓ https://${projectName.toLowerCase()}.deploykit.local live`,
  ];
}
