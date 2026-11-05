export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function timeAgo(iso: string) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function shortRepo(url: string) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, "").replace(/\.git$/, "") || u.hostname;
  } catch {
    return url;
  }
}

export function formatTrigger(trigger: string): string {
  switch (trigger) {
    case "github_pull_request":
      return "Pull Request";
    case "github_push":
      return "GitHub Push";
    case "rollback":
      return "Rollback";
    case "manual":
      return "Manual";
    default:
      return trigger;
  }
}

