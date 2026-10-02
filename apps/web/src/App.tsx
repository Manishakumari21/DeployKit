import { useMemo, useState } from "react";
import { DeploymentDetails, DeploymentList } from "./components/deployments";
import { DomainsView, LogsView, SettingsView } from "./components/OpsViews";
import { ProjectModal } from "./components/ProjectModal";
import { ServiceHeader } from "./components/ServiceHeader";
import { ServicesGrid } from "./components/ServicesGrid";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { Topbar } from "./components/Topbar";
import { useDeployments } from "./hooks/useDeployments";
import { useProjects, useToast } from "./hooks/useProjects";
import type { ApiDeployment, NavKey } from "./types";

const SELECTED_KEY = "deploykit:selected-project";

export default function App() {
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
      setToast(`Deployment ${d.status}: ${d.id.slice(0, 8)}`);
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
      setToast(`Service "${c.name}" created`);
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
    <div className="grid min-h-screen bg-zinc-950 text-zinc-100 lg:grid-cols-[240px_1fr]">
      <Sidebar
        nav={nav}
        setNav={setNav}
        counts={{ services: projects.length, deployments: deployments.length }}
        healthy={healthy}
      />
      <div className="min-w-0">
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

        <main className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6">
          {nav === "overview" && (
            <>
              <ServiceHeader project={featured} live={live} creating={deploying} onDeploy={handleDeploy} />
              {createError && <p className="text-[13px] text-red-300">{createError}</p>}
              <div className="grid items-start gap-3 xl:grid-cols-2">
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
                  <p className="text-[13px] text-zinc-500">Select a deployment to see details.</p>
                )}
              </div>
            </>
          )}

          {nav === "services" && (
            <>
              <div className="flex items-end justify-between">
                <div>
                  <h1 className="text-lg font-semibold tracking-tight text-white">Services</h1>
                  <p className="text-[13px] text-zinc-500">{services.length} services</p>
                </div>
              </div>
              <ServicesGrid
                projects={services}
                loading={loading}
                selectedId={selectedProjectId}
                onNew={() => setModal(true)}
                onSelect={selectProject}
                onDelete={async (id) => {
                  await remove(id);
                  setToast("Service removed");
                }}
              />
            </>
          )}

          {nav === "deployments" && (
            <div className="grid items-start gap-3 xl:grid-cols-2">
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
          {nav === "logs" && <LogsView />}
          {nav === "settings" && <SettingsView />}
        </main>
      </div>

      <ProjectModal open={modal} busy={creating} error={formError} onClose={() => setModal(false)} onSubmit={submit} />
      <Toast msg={toast} onClose={() => setToast(null)} />
    </div>
  );
}
