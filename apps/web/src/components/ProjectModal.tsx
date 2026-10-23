import { GitBranch, GitPullRequest, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchGitHubConnection, fetchGitHubRepositories } from "../lib/api";
import type { GitHubConnection, GitHubRepository, GitHubSelection } from "../types";
import { DeployBtn, Panel, QuietBtn } from "./ui";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function isNoRepositories(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 ||
      error.code === "GITHUB_NOT_CONNECTED" ||
      error.code === "GITHUB_NO_REPOSITORIES")
  );
}

function repoServiceName(repo: GitHubRepository): string {
  const base = repo.name || repo.fullName.split("/").pop() || "service";
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return normalized || "service";
}

export function ProjectModal({
  open,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (
    name: string,
    repo: string,
    branch: string,
    github?: GitHubSelection
  ) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [manual, setManual] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [connection, setConnection] = useState<GitHubConnection | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState("");
  const [selectedRepoId, setSelectedRepoId] = useState("");

  const resetForm = useCallback(() => {
    setName("");
    setRepo("");
    setBranch("main");
    setManual(false);
    setNameTouched(false);
    setConnection(null);
    setConnectionError("");
    setRepositories([]);
    setReposLoading(false);
    setReposError("");
    setSelectedRepoId("");
  }, []);

  const refreshRepos = useCallback(async (signal?: AbortSignal) => {
    setReposLoading(true);
    setReposError("");
    try {
      const data = await fetchGitHubRepositories(signal);
      setRepositories(data.repositories);
    } catch (fetchError) {
      if (isAbort(fetchError)) return;
      if (isNoRepositories(fetchError)) {
        setRepositories([]);
        return;
      }
      setReposError(messageOf(fetchError, "Could not load GitHub repositories."));
    } finally {
      setReposLoading(false);
    }
  }, []);

  const fetchConnection = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      try {
        const result = await fetchGitHubConnection(signal);
        setConnection(result);
        return result.configured && !result.error;
      } catch (fetchError) {
        if (isAbort(fetchError)) return false;
        setConnectionError(messageOf(fetchError, "Could not check the GitHub connection."));
        return false;
      }
    },
    []
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetchGitHubConnection(controller.signal)
      .then((result) => {
        setConnection(result);
        if (!result.configured || result.error) return;
        setReposLoading(true);
        fetchGitHubRepositories(controller.signal)
          .then((data) => setRepositories(data.repositories))
          .catch((repoError) => {
            if (isAbort(repoError)) return;
            if (isNoRepositories(repoError)) {
              setRepositories([]);
              return;
            }
            setReposError(messageOf(repoError, "Could not load GitHub repositories."));
          })
          .finally(() => setReposLoading(false));
      })
      .catch((fetchError) => {
        if (isAbort(fetchError)) return;
        setConnectionError(messageOf(fetchError, "Could not check the GitHub connection."));
      });
    return () => controller.abort();
  }, [open]);

  if (!open) return null;

  const input =
    "w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 text-[13px] text-fog-100 shadow-[inset_0_1px_0_rgb(194_220_245/0.05)] outline-none placeholder:text-fog-500 focus:border-signal-500 disabled:cursor-not-allowed disabled:opacity-60";
  const smallBtn =
    "cursor-pointer rounded-md border border-edge bg-ink-800 px-2.5 py-1.5 text-[12px] font-medium text-fog-200 transition hover:border-fog-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50";
  const tab = (active: boolean) =>
    `cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
      active
        ? "bg-ink-700 text-white shadow-[inset_0_1px_0_rgb(194_220_245/0.08)]"
        : "text-fog-500 hover:text-fog-100"
    }`;

  const selected = repositories.find((item) => String(item.id) === selectedRepoId);
  const canSubmit =
    !busy &&
    name.trim().length > 0 &&
    (manual ? repo.trim().length > 0 : Boolean(selected));

  const retryConnection = () => {
    setConnection(null);
    setConnectionError("");
    void fetchConnection().then((shouldLoad) => {
      if (shouldLoad) void refreshRepos();
    });
  };

  const connectGitHub = async () => {
    setReposError("");
    try {
      const result = await fetchGitHubConnection();
      setConnection(result);
      if (!result.installUrl) {
        setReposError(result.error ?? "GitHub is not configured.");
        return;
      }
      window.open(result.installUrl, "_blank", "noopener,noreferrer");
    } catch (connectError) {
      setReposError(messageOf(connectError, "Could not start the GitHub connection."));
    }
  };

  const selectRepository = (value: string) => {
    setSelectedRepoId(value);
    const item = repositories.find((candidate) => String(candidate.id) === value);
    if (!item) {
      setRepo("");
      return;
    }
    if (!nameTouched) setName(repoServiceName(item));
    setRepo(item.htmlUrl);
    setBranch(item.defaultBranch || "main");
  };

  const chooseManual = () => {
    setManual(true);
    setSelectedRepoId("");
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink-950/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div onClick={(event) => event.stopPropagation()} className="w-full max-w-lg animate-rise">
        <Panel className="max-h-[calc(100vh-2rem)] overflow-y-auto p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[16px] font-bold tracking-tight text-white">
                Commission a service
              </h2>
              <p className="mt-0.5 flex items-center gap-1 font-mono text-[12px] text-fog-500">
                <GitBranch size={12} className="text-signal-300" /> connect a repository, then
                deploy from clone to live
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="cursor-pointer rounded-md p-1 text-fog-500 transition hover:text-white"
            >
              <X size={16} />
            </button>
          </div>

          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const github =
                !manual && selected
                  ? {
                      installationId: selected.installationId,
                      repositoryFullName: selected.fullName,
                      repositoryId: selected.id,
                    }
                  : undefined;
              if (await onSubmit(name, repo, branch, github)) resetForm();
            }}
            className="flex flex-col gap-3"
          >
            <div
              role="group"
              aria-label="Repository source"
              className="grid grid-cols-2 gap-1 rounded-xl border border-edge bg-ink-950 p-1"
            >
              <button
                type="button"
                aria-pressed={!manual}
                onClick={() => setManual(false)}
                disabled={busy}
                className={tab(!manual)}
              >
                GitHub
              </button>
              <button
                type="button"
                aria-pressed={manual}
                onClick={chooseManual}
                disabled={busy}
                className={tab(manual)}
              >
                Git URL
              </button>
            </div>

            {!manual && (
              <div className="flex flex-col gap-2.5">
                {connection === null && !connectionError && (
                  <div className="flex items-center gap-2 rounded-xl border border-edge bg-ink-950 px-3 py-2.5 text-[12px] text-fog-500">
                    <RefreshCw size={13} className="animate-spin-slower text-signal-300" />
                    Checking GitHub…
                  </div>
                )}

                {connectionError && (
                  <div
                    role="alert"
                    className="rounded-xl border border-red-900 bg-red-950/40 p-3 text-[12px] text-red-200"
                  >
                    <p>{connectionError}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={retryConnection}
                        className={smallBtn}
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={chooseManual}
                        className={smallBtn}
                      >
                        Use a Git URL instead
                      </button>
                    </div>
                  </div>
                )}

                {connection && !connection.configured && (
                  <div className="rounded-xl border border-amber-900/60 bg-amber-950/25 p-3">
                    <p className="text-[12px] font-semibold text-amber-200">
                      GitHub is not connected on this instance
                    </p>
                    <p className="mt-1 text-[12px] leading-relaxed text-fog-400">
                      {connection.error ??
                        "Configure the GitHub App before choosing a repository."}
                    </p>
                    <p className="mt-2 text-[11px] text-fog-500">GitHub App setup URL</p>
                    <code className="mt-1 block break-all rounded-md border border-edge bg-ink-950 px-2 py-1 font-mono text-[11px] text-fog-200">
                      {connection.callbackUrl}
                    </code>
                    <button
                      type="button"
                      onClick={chooseManual}
                      className={`${smallBtn} mt-3`}
                    >
                      Use a Git URL instead
                    </button>
                  </div>
                )}

                {connection && connection.configured && connection.error && (
                  <div
                    role="alert"
                    className="rounded-xl border border-amber-900/60 bg-amber-950/25 p-3 text-[12px] text-amber-100"
                  >
                    <p>{connection.error}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={retryConnection}
                        className={smallBtn}
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={chooseManual}
                        className={smallBtn}
                      >
                        Use a Git URL instead
                      </button>
                    </div>
                  </div>
                )}

                {connection && connection.configured && !connection.error && (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[12px] font-medium text-fog-200">Repository</p>
                        <p className="text-[11px] text-fog-500">
                          Choose a repo from your connected GitHub App.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <QuietBtn
                          type="button"
                          onClick={() => void connectGitHub()}
                          disabled={busy}
                          className="text-[12px]"
                        >
                          <GitPullRequest size={14} /> Connect GitHub
                        </QuietBtn>
                        <QuietBtn
                          type="button"
                          onClick={() => void refreshRepos()}
                          disabled={busy || reposLoading}
                          aria-label="Refresh repositories"
                          className="text-[12px]"
                        >
                          <RefreshCw
                            size={14}
                            className={reposLoading ? "animate-spin-slower" : ""}
                          />{" "}
                          Refresh
                        </QuietBtn>
                      </div>
                    </div>

                    {reposLoading && (
                      <div className="flex items-center gap-2 rounded-xl border border-edge bg-ink-950 px-3 py-2.5 text-[12px] text-fog-500">
                        <RefreshCw size={13} className="animate-spin-slower text-signal-300" />
                        Loading repositories…
                      </div>
                    )}

                    {!reposLoading && reposError && (
                      <div
                        role="alert"
                        className="rounded-xl border border-red-900 bg-red-950/40 p-3 text-[12px] text-red-200"
                      >
                        <p>{reposError}</p>
                        <button
                          type="button"
                          onClick={() => void refreshRepos()}
                          className={`${smallBtn} mt-2`}
                        >
                          Retry
                        </button>
                      </div>
                    )}

                    {!reposLoading && !reposError && repositories.length === 0 && (
                      <div className="rounded-xl border border-dashed border-edge bg-ink-950/60 px-3 py-3 text-[12px] text-fog-500">
                        No repositories yet. Install the GitHub App, then refresh.
                      </div>
                    )}

                    {!reposLoading && !reposError && repositories.length > 0 && (
                      <>
                        <label className="flex flex-col gap-1 text-[12px] font-medium text-fog-200">
                          Repository
                          <select
                            aria-label="Repository"
                            value={selectedRepoId}
                            onChange={(event) => selectRepository(event.target.value)}
                            disabled={busy}
                            className={`${input} font-mono`}
                          >
                            <option value="">Choose a repository…</option>
                            {repositories.map((item) => (
                              <option key={item.id} value={String(item.id)}>
                                {item.fullName}
                                {item.private ? " · private" : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        {selected && (
                          <div className="rounded-lg border border-edge bg-ink-950 px-3 py-2">
                            <p className="text-[11px] font-medium text-fog-500">
                              Repository URL
                            </p>
                            <p className="mt-0.5 truncate font-mono text-[11px] text-signal-300">
                              {selected.htmlUrl}
                            </p>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {manual && (
              <label className="flex flex-col gap-1 text-[12px] font-medium text-fog-200">
                Git URL
                <input
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder="https://github.com/acme/website"
                  inputMode="url"
                  maxLength={2048}
                  disabled={busy}
                  className={`${input} font-mono`}
                />
              </label>
            )}

            <label className="flex flex-col gap-1 text-[12px] font-medium text-fog-200">
              Service name
              <input
                autoFocus
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameTouched(true);
                }}
                placeholder="marketing-site"
                maxLength={60}
                disabled={busy}
                className={input}
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-fog-200">
              Branch
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
                maxLength={100}
                disabled={busy}
                className={`${input} font-mono`}
              />
            </label>

            {error && (
              <p
                role="alert"
                className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[12px] text-red-200"
              >
                {error}
              </p>
            )}
            <div className="mt-1 flex justify-end gap-1.5">
              <QuietBtn type="button" onClick={onClose} disabled={busy}>
                Cancel
              </QuietBtn>
              <DeployBtn type="submit" disabled={!canSubmit}>
                {busy ? "Commissioning…" : "Commission service"}
              </DeployBtn>
            </div>
          </form>
        </Panel>
      </div>
    </div>
  );
}
