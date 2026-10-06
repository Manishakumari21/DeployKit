import { useMemo, useState } from "react";
import { DeploymentDetails, DeploymentList } from "./components/deployments";
import { CommandBar } from "./components/CommandBar";
import { DomainsView, LogsView, SettingsView } from "./components/OpsViews";
import { LoginView } from "./components/LoginView";
import { MetricsPanel } from "./components/MetricsPanel";
import { ProjectModal } from "./components/ProjectModal";
import { ServiceHeader } from "./components/ServiceHeader";
import { ServicesGrid } from "./components/ServicesGrid";
import { Toast } from "./components/Toast";
import { Topbar } from "./components/Topbar";
import { Eyebrow } from "./components/ui";
import { useAuth } from "./hooks/useAuth";
import { useDeployments } from "./hooks/useDeployments";
import { useProjects, useToast } from "./hooks/useProjects";
import type { ApiDeployment, AuthUser, NavKey } from "./types";

const SELECTED_KEY = "deploykit:selected-project";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="dk-noise min-h-screen bg-ink-950 font-sans text-fog-100">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[80] focus:rounded-lg focus:bg-signal-400 focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink-950"
      >
        Skip to content
      </a>
      <div aria-hidden className="dk-grid-bg pointer-events-none fixed inset-0" />
      {children}
    </div>
  );
}

export default function App() {
  const auth = useAuth();

  if (auth.status === "loading") {
    return (
      <Shell>
        <main className="mx-auto flex min-h-[70vh] w-full max-w-6xl items-center justify-center px-4">
          <p className="animate-pulse font-mono text-[13px] text-fog-500" role="status">
            linking…
          </p>
        </main>
      </Shell>
    );
  }

  // Unauthenticated users never reach dashboard hooks or data: the session
  // probe is the single gate, so stray 401s cannot cause redirect loops.
  if (auth.status === "unauthenticated" || !auth.user) {
    return (
      <Shell>
        <LoginView busy={auth.busy} error={auth.error} onLogin={auth.login} onRegister={auth.register} />
      </Shell>
    );
  }

  return <Dashboard user={auth.user} onLogout={() => void auth.logout()} />;
}

function Dashboard({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [nav, setNav] = useState<NavKey>("overview");
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(false);
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);
  const { toast, setToast } = useToast();
  const { projects, healthy, loading, refreshing, load, remove, add } = useProjects(setToast);

  const [storedId, setStoredId] = useState<string | null>(() =>
    localStorage.getItem(SELECTED_KEY)
  );
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(null);

  const newestProjectId = useMemo(() => {
    if (!projects.length) return null;
    return [...projects].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0].id;
  }, [projects]);
  const selectedProjectId =
    storedId && projects.some((p) => p.id === storedId) ? storedId : newestProjectId;

  const selectProject = (id: string) => {
    setStoredId(id);
    localStorage.setItem(SELECTED_KEY, id);
    setSelectedDeploymentId(null);
  };

  const {
    deployments,
    loading: depLoading,
    error: depError,
    reload: reloadDeployments,
    creating: deploying,
    createError,
    create,
    setDeployments,
  } = useDeployments(selectedProjectId);

  const q = query.trim().toLowerCase();
  const services = useMemo(() => {
    const list = q
      ? projects.filter((p) => `${p.name} ${p.repository_url} ${p.branch}`.toLowerCase().includes(q))
      : projects;
    return [...list].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  }, [projects, q]);

  const featured = services.find((p) => p.id === selectedProjectId) ?? services[0];
  const live: ApiDeployment | undefined = deployments[0];
  const selectedId = selectedDeploymentId ?? live?.id ?? null;

  const handleDeploy = async () => {
    if (!selectedProjectId || deploying) return;
    const d = await create();
    if (d) {
      setSelectedDeploymentId(d.id);
      setToast(`Flight ${d.id.slice(0, 8)} away — ${d.status}`);
    } else {
      setToast(createError ?? "Failed to create deployment");
    }
  };

  const handleListUpdate = (d: ApiDeployment) => {
    setDeployments((prev) => prev.map((x) => (x.id === d.id ? { ...x, ...d } : x)));
  };

  const refreshAll = () => {
    load();
    reloadDeployments();
  };

  const submit = async (name: string, repo: string, branch: string) => {
    setFormError("");
    if (!name.trim()) {
      setFormError("Service name is required.");
      return false;
    }
    if (!/^https?:\/\/.+/.test(repo.trim())) {
      setFormError("Git URL must start with http(s)://");
      return false;
    }
    setCreating(true);
    try {
      const c = await add(name, repo, branch);
      setModal(false);
      selectProject(c.id);
      setToast(`Service "${c.name}" commissioned`);
      setNav("services");
      return true;
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen">
      <div className="sticky top-0 z-40">
        <CommandBar
          nav={nav}
          setNav={setNav}
          counts={{ services: projects.length, deployments: deployments.length }}
          healthy={healthy}
          userEmail={user.email}
          onLogout={onLogout}
        />
        <Topbar
          query={query}
          setQuery={setQuery}
          refreshing={refreshing}
          onRefresh={refreshAll}
          onNew={() => {
            setFormError("");
            setModal(true);
          }}
          onDeploy={handleDeploy}
          deploying={deploying}
          canDeploy={!!selectedProjectId}
        />
      </div>

      <main id="main" className="relative mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6">
        {nav === "overview" && (
          <div className="dk-stagger flex flex-col gap-4">
            <ServiceHeader project={featured} live={live} creating={deploying} onDeploy={handleDeploy} />
            {createError && <p role="alert" className="text-[13px] text-red-300">{createError}</p>}
            <MetricsPanel projectId={selectedProjectId} />
            <div className="grid items-start gap-4 xl:grid-cols-2">
              <DeploymentList
                deployments={deployments.slice(0, 8)}
                loading={depLoading}
                error={depError}
                selectedId={selectedId}
                onSelect={setSelectedDeploymentId}
                onRetry={reloadDeployments}
              />
              {selectedId ? (
                <DeploymentDetails deploymentId={selectedId} onUpdate={handleListUpdate} />
              ) : (
                <p className="text-[13px] text-fog-500">Select a flight to track it down the rail.</p>
              )}
            </div>
          </div>
        )}

        {nav === "services" && (
          <div className="dk-stagger flex flex-col gap-3">
            <div className="flex items-end justify-between">
              <div>
                <Eyebrow>Fleet roster</Eyebrow>
                <h1 className="mt-1 text-xl font-bold tracking-tight text-white">
                  {services.length} {services.length === 1 ? "service" : "services"}
                </h1>
              </div>
            </div>
            <ServicesGrid
              projects={services}
              loading={loading}
              selectedId={selectedProjectId}
              onNew={() => setModal(true)}
              onSelect={selectProject}
              onDelete={async (id) => {
                try {
                  await remove(id);
                  setToast("Service decommissioned");
                } catch (e) {
                  setToast(e instanceof Error ? e.message : "Failed to delete service");
                }
              }}
            />
          </div>
        )}

        {nav === "deployments" && (
          <div className="dk-stagger grid items-start gap-4 xl:grid-cols-2">
            <DeploymentList
              deployments={deployments}
              loading={depLoading}
              error={depError}
              selectedId={selectedId}
              onSelect={setSelectedDeploymentId}
              onRetry={reloadDeployments}
            />
            {selectedId && <DeploymentDetails deploymentId={selectedId} onUpdate={handleListUpdate} />}
          </div>
        )}
        {nav === "domains" && <DomainsView />}
        {nav === "logs" && (
          <LogsView
            deployments={deployments}
            selectedId={selectedId}
            onSelect={(id) => setSelectedDeploymentId(id)}
          />
        )}
        {nav === "settings" && <SettingsView />}

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 pb-4 font-mono text-[11px] text-fog-500">
          <span>deploykit · self-hosted</span>
          <span aria-hidden>·</span>
          <span className={healthy ? "text-signal-400" : "text-amber-300"}>
            {healthy === null ? "linking…" : healthy ? "api live" : "api unreachable"}
          </span>
          <span className="ml-auto">queue → build → gateway → live</span>
        </footer>
      </main>

      <ProjectModal open={modal} busy={creating} error={formError} onClose={() => setModal(false)} onSubmit={submit} />
      <Toast msg={toast} onClose={() => setToast(null)} />
    </div>
  );
}
