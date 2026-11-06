import { GitBranch, Lock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchGitHubConnection,
  fetchGitHubRepositories,
  fetchProjectGithubLink,
  linkProjectGithub,
  unlinkProjectGithub,
} from "../lib/api";
import type {
  GitHubConnection,
  GitHubLink,
  GitHubRepository,
  Project,
} from "../types";
import { DangerBtn, DeployBtn, EmptyState, Panel, PanelHead, QuietBtn, Skeleton } from "./ui";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

// Mirrors ProjectModal: the API signals "nothing installed yet" as 404 or one of
// these codes, which is an empty state rather than a failure.
function isNoRepositories(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 ||
      error.code === "GITHUB_NOT_CONNECTED" ||
      error.code === "GITHUB_NO_REPOSITORIES")
  );
}

const input =
  "w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 text-[13px] text-fog-100 shadow-[inset_0_1px_0_rgb(194_220_245/0.05)] outline-none placeholder:text-fog-500 focus:border-signal-500 disabled:cursor-not-allowed disabled:opacity-60";

const rowClasses =
  "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge bg-ink-900/60 px-3 py-2.5";

function VisibilityPill({ isPrivate }: { isPrivate: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] ${
        isPrivate
          ? "border border-amber-500/30 bg-amber-950/40 text-amber-300"
          : "border border-edge bg-ink-800 text-fog-500"
      }`}
    >
      <Lock size={10} aria-hidden />
      {isPrivate ? "private" : "public"}
    </span>
  );
}

function AutoDeployPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 font-mono text-[11px] ${
        enabled
          ? "border border-signal-500/30 bg-signal-950/40 text-signal-300"
          : "border border-edge bg-ink-800 text-fog-500"
      }`}
    >
      {enabled ? "auto-deploy on" : "auto-deploy off"}
    </span>
  );
}

export function GitHubView({
  projects,
  onNotify,
  onProjectUpdate,
}: {
  projects: Project[];
  onNotify?: (message: string) => void;
  onProjectUpdate?: () => void;
}) {
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [connecting, setConnecting] = useState(false);

  const [repos, setRepos] = useState<GitHubRepository[]>([]);
  const [reposTruncated, setReposTruncated] = useState(false);
  const [reposFailed, setReposFailed] = useState(0);
  const [page, setPage] = useState(1);
  const [reposLoading, setReposLoading] = useState(true);
  const [reposError, setReposError] = useState("");
  const [reposExhausted, setReposExhausted] = useState(false);
  const [repoFilter, setRepoFilter] = useState("");

  const [links, setLinks] = useState<Record<string, GitHubLink>>({});
  const [linksLoading, setLinksLoading] = useState(projects.length > 0);
  const [linksError, setLinksError] = useState("");
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [confirmUnlink, setConfirmUnlink] = useState<{
    project: Project;
    repoFullName: string;
  } | null>(null);

  // Stable handle to the install popup so the close-watcher can detect it.
  const connectRef = useRef<Window | null>(null);

  const loadConnection = useCallback((signal?: AbortSignal) => {
    return fetchGitHubConnection(signal)
      .then((value) => {
        setConnection(value);
        setConnectionError("");
      })
      .catch((fetchError) => {
        if (isAbort(fetchError)) return;
        setConnectionError(messageOf(fetchError, "Could not check the GitHub connection."));
      });
  }, []);

  const loadRepositories = useCallback(async (targetPage: number, signal?: AbortSignal) => {
    setReposLoading(true);
    setReposError("");
    try {
      const result = await fetchGitHubRepositories(targetPage, signal);
      setRepos(result.repositories);
      setReposTruncated(result.truncated);
      setReposFailed(result.failed);
      setPage(targetPage);
      setReposExhausted(false);
    } catch (fetchError) {
      if (isAbort(fetchError)) return;
      if (targetPage > 1 && isNoRepositories(fetchError)) {
        // A page past the end is an exhausted list, not a failure.
        setRepos([]);
        setReposTruncated(false);
        setReposFailed(0);
        setReposExhausted(true);
        return;
      }
      if (isNoRepositories(fetchError)) {
        setRepos([]);
        setReposTruncated(false);
        setReposFailed(0);
        setReposError("");
        return;
      }
      setReposError(messageOf(fetchError, "Could not load GitHub repositories."));
    } finally {
      setReposLoading(false);
    }
  }, []);

  const refreshAll = useCallback(
    async (signal?: AbortSignal) => {
      await Promise.all([loadConnection(signal), loadRepositories(page, signal)]);
    },
    [loadConnection, loadRepositories, page]
  );

  useEffect(() => {
    const controller = new AbortController();
    loadConnection(controller.signal).finally(() => loadRepositories(1, controller.signal));
    return () => controller.abort();
  }, [loadConnection, loadRepositories]);

  // The installation callback is a server-rendered popup page with no
  // postMessage contract; re-query the connection when the popup closes.
  useEffect(() => {
    if (!connection?.installUrl || !connecting) return;
    const popup = connectRef.current;
    const timer = window.setInterval(() => {
      if (popup && !popup.closed) return;
      window.clearInterval(timer);
      setConnecting(false);
      void refreshAll();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [connection?.installUrl, connecting, refreshAll]);

  useEffect(() => {
    if (projects.length === 0) {
      setLinks({});
      setLinksLoading(false);
    }
    const controller = new AbortController();
    setLinksLoading(true);
    setLinksError("");
    Promise.all(
      projects.map((project) =>
        fetchProjectGithubLink(project.id, controller.signal)
          .then((link) => [project.id, link] as const)
          .catch((fetchError) => {
            if (isAbort(fetchError)) throw fetchError;
            return [project.id, { project_id: project.id, linked: false }] as const;
          })
      )
    )
      .then((entries) => {
        if (controller.signal.aborted) return;
        setLinks(Object.fromEntries(entries));
        setLinksLoading(false);
      })
      .catch((fetchError) => {
        if (isAbort(fetchError)) return;
        setLinksLoading(false);
        setLinksError(messageOf(fetchError, "Could not load repository links."));
      });
    return () => controller.abort();
  }, [projects]);

  const connect = () => {
    if (!connection?.installUrl) return;
    const popup = window.open(connection.installUrl, "deploykit-github", "width=720,height=760");
    connectRef.current = popup;
    setConnecting(true);
  };

  const linkProject = async (project: Project) => {
    const repoId = selection[project.id];
    const repo = repos.find((item) => String(item.id) === repoId);
    if (!repo) return;
    setBusyProjectId(project.id);
    try {
      await linkProjectGithub(project.id, {
        installationId: repo.installationId,
        repositoryFullName: repo.fullName,
        repositoryId: repo.id,
        autoDeploy: true,
      });
      const link = await fetchProjectGithubLink(project.id);
      setLinks((prev) => ({ ...prev, [project.id]: link }));
      onNotify?.(`${project.name} linked to ${repo.fullName}`);
      onProjectUpdate?.();
    } catch (linkError) {
      if (isAbort(linkError)) return;
      onNotify?.(messageOf(linkError, "Failed to link the repository."));
    } finally {
      setBusyProjectId(null);
    }
  };

  const unlinkProject = async (project: Project) => {
    setBusyProjectId(project.id);
    try {
      await unlinkProjectGithub(project.id);
      setLinks((prev) => ({
        ...prev,
        [project.id]: { project_id: project.id, linked: false },
      }));
      onNotify?.(`${project.name} unlinked`);
      onProjectUpdate?.();
    } catch (unlinkError) {
      if (isAbort(unlinkError)) return;
      onNotify?.(messageOf(unlinkError, "Failed to unlink the repository."));
    } finally {
      setBusyProjectId(null);
    }
  };

  const toggleAutoDeploy = async (project: Project, currentLink: GitHubLink) => {
    if (!currentLink.full_name) return;
    setBusyProjectId(project.id);
    try {
      await linkProjectGithub(project.id, {
        installationId: String(currentLink.installation_id ?? ""),
        repositoryFullName: currentLink.full_name,
        repositoryId: currentLink.repository_id ? Number(currentLink.repository_id) : undefined,
        autoDeploy: !currentLink.auto_deploy,
      });
      const link = await fetchProjectGithubLink(project.id);
      setLinks((prev) => ({ ...prev, [project.id]: link }));
      onNotify?.(
        `Auto-deploy ${!currentLink.auto_deploy ? "enabled" : "disabled"} for ${project.name}`
      );
      onProjectUpdate?.();
    } catch (err) {
      if (isAbort(err)) return;
      onNotify?.(messageOf(err, "Failed to update auto-deploy setting."));
    } finally {
      setBusyProjectId(null);
    }
  };

  const filteredRepos = repos.filter((repo) => {
    const needle = repoFilter.trim().toLowerCase();
    if (!needle) return true;
    return (
      repo.fullName.toLowerCase().includes(needle) ||
      repo.name.toLowerCase().includes(needle) ||
      repo.owner.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="dk-stagger flex flex-col gap-4">
      <Panel className="p-5">
        <PanelHead
          title="GitHub connection"
          right={
            connection?.configured && connection.installUrl ? (
              <DeployBtn onClick={connect} disabled={connecting} className="text-[12px]">
                {connecting ? "Waiting for GitHub…" : "Connect GitHub App"}
              </DeployBtn>
            ) : undefined
          }
        />
        {connectionError ? (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-[13px] text-red-300" role="alert">
            {connectionError}
          </p>
        ) : connection === null ? (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
        ) : !connection.configured ? (
          <EmptyState
            title="GitHub is not configured"
            body={connection.error ?? "Set the GitHub App credentials on the server before connecting."}
          />
        ) : connection.error ? (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-[13px] text-amber-300">
            {connection.error}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-signal-500/30 bg-signal-950/40 px-2.5 py-1 font-mono text-[11px] text-signal-300">
              GitHub App installed
            </span>
            <span className="font-mono text-[11px] text-fog-500">
              callback {connection.callbackUrl}
            </span>
            <QuietBtn
              onClick={() => void refreshAll()}
              disabled={reposLoading}
              className="text-[12px]"
            >
              <RefreshCw size={12} className="mr-1 inline" aria-hidden /> Refresh
            </QuietBtn>
          </div>
        )}
      </Panel>

      <Panel className="p-5">
        <PanelHead
          title="Repositories"
          right={
            <>
              <input
                value={repoFilter}
                onChange={(event) => setRepoFilter(event.target.value)}
                placeholder="Filter by name or owner"
                aria-label="Filter repositories"
                className={`${input} w-44 py-1.5`}
              />
              <QuietBtn
                onClick={() => void loadRepositories(page - 1)}
                disabled={reposLoading || page <= 1}
                className="text-[12px]"
              >
                Prev
              </QuietBtn>
              <QuietBtn
                onClick={() => void loadRepositories(page + 1)}
                disabled={reposLoading || (!reposTruncated && !reposExhausted ? repos.length === 0 : false) || reposExhausted}
                className="text-[12px]"
              >
                Next
              </QuietBtn>
              <span className="font-mono text-[11px] text-fog-500">page {page}</span>
            </>
          }
        />
        {reposError && (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-[13px] text-red-300" role="alert">
            {reposError}
          </p>
        )}
        {!reposError && (reposTruncated || reposFailed > 0) && (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 font-mono text-[12px] text-amber-300">
            This page may be incomplete
            {reposFailed > 0 ? ` — ${reposFailed} installation${reposFailed === 1 ? "" : "s"} could not be reached` : ""}.
          </p>
        )}
        {reposLoading ? (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : filteredRepos.length === 0 && !reposError && !reposExhausted ? (
          <EmptyState
            title={repoFilter ? "No repositories match" : "No installed repositories"}
            body={
              repoFilter
                ? "Try a different filter."
                : connection?.configured
                  ? "Install the GitHub App on at least one repository to see it here."
                  : "Connect GitHub to see your repositories."
            }
            action={
              !repoFilter && connection?.configured && connection.installUrl ? (
                <DeployBtn onClick={connect} disabled={connecting} className="text-[12px]">
                  Connect GitHub App
                </DeployBtn>
              ) : undefined
            }
          />
        ) : reposExhausted ? (
          <EmptyState
            title="End of repository list"
            body="There are no repositories on this page."
          />
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {filteredRepos.map((repo) => (
              <li key={`${repo.installationId}-${repo.id}`} className={rowClasses}>
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold text-fog-100">{repo.fullName}</p>
                  <p className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-fog-500">
                    <GitBranch size={10} aria-hidden /> {repo.defaultBranch}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <VisibilityPill isPrivate={repo.private} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel className="p-5">
        <PanelHead title="Linked services" />
        {linksError && (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-[13px] text-red-300" role="alert">
            {linksError}
          </p>
        )}
        {linksLoading ? (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            title="No services yet"
            body="Create a service first, then link a repository to it."
          />
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {projects.map((project) => {
              const link = links[project.id];
              const linked = link?.linked === true && link.full_name;
              const selectedRepoId = selection[project.id] ?? "";
              const busy = busyProjectId === project.id;
              return (
                <li key={project.id} className={rowClasses}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-fog-100">{project.name}</p>
                    {linked ? (
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-fog-500">
                        <span className="truncate">{link.full_name}</span>
                        <button
                          type="button"
                          onClick={() => void toggleAutoDeploy(project, link)}
                          disabled={busy}
                          title={link.auto_deploy ? "Disable auto-deploy" : "Enable auto-deploy"}
                          aria-label={`Toggle auto-deploy for ${project.name}`}
                          className="cursor-pointer transition hover:opacity-80"
                        >
                          <AutoDeployPill enabled={link.auto_deploy === true} />
                        </button>
                      </div>
                    ) : (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <select
                          value={selectedRepoId}
                          onChange={(event) =>
                            setSelection((prev) => ({ ...prev, [project.id]: event.target.value }))
                          }
                          aria-label={`Repository for ${project.name}`}
                          className={`${input} w-auto max-w-52 py-1.5`}
                          disabled={busy}
                        >
                          <option value="">Select repository…</option>
                          {repos.map((repo) => (
                            <option key={repo.id} value={String(repo.id)}>
                              {repo.fullName}
                            </option>
                          ))}
                        </select>
                        <DeployBtn
                          onClick={() => void linkProject(project)}
                          disabled={busy || !selectedRepoId}
                          className="text-[12px]"
                        >
                          {busy ? "Linking…" : "Link"}
                        </DeployBtn>
                      </div>
                    )}
                  </div>
                  {linked && (
                    <DangerBtn
                      onClick={() =>
                        setConfirmUnlink({
                          project,
                          repoFullName: link.full_name ?? "repository",
                        })
                      }
                      disabled={busy}
                      className="text-[12px]"
                    >
                      {busy ? "Unlinking…" : "Unlink"}
                    </DangerBtn>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {confirmUnlink && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="unlink-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-2xl border border-edge bg-ink-900 p-6 shadow-2xl">
            <h2 id="unlink-dialog-title" className="text-base font-bold text-white">
              Unlink repository?
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-fog-400">
              Are you sure you want to unlink <span className="font-mono text-fog-200">{confirmUnlink.repoFullName}</span> from service <span className="font-semibold text-white">"{confirmUnlink.project.name}"</span>?
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-fog-500">
              This will disable automatic deployments on push. Existing deployments, runtime containers, and project history will remain intact.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <QuietBtn
                type="button"
                onClick={() => setConfirmUnlink(null)}
                disabled={busyProjectId === confirmUnlink.project.id}
                className="text-[12px]"
              >
                Cancel
              </QuietBtn>
              <DangerBtn
                type="button"
                onClick={async () => {
                  const target = confirmUnlink.project;
                  setConfirmUnlink(null);
                  await unlinkProject(target);
                }}
                disabled={busyProjectId === confirmUnlink.project.id}
                className="text-[12px]"
              >
                {busyProjectId === confirmUnlink.project.id ? "Unlinking…" : "Confirm Unlink"}
              </DangerBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
