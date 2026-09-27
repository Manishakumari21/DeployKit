import { useMemo, useState } from "react";
import { DeployTimeline } from "./components/DeployTimeline";
import { DeploysTable } from "./components/DeploysTable";
import { DomainsView, LogsView, SettingsView } from "./components/OpsViews";
import { ProjectModal } from "./components/ProjectModal";
import { ResourceBars, ServiceHeader } from "./components/ServiceHeader";
import { MetricsRow } from "./components/ServiceHeader";
import { ServicesGrid } from "./components/ServicesGrid";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { Topbar } from "./components/Topbar";
import { Panel, PanelHead } from "./components/ui";
import { useProjects, useToast } from "./hooks/useProjects";
import { fakeLogs, toDeployments, toDomains } from "./lib/deploy";
import type { NavKey } from "./types";

export default function App() {
  const [nav, setNav] = useState<NavKey>("overview");
  const [env, setEnv] = useState<"production" | "preview">("production");
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(false);
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);
  const { toast, setToast } = useToast();
  const { projects, healthy, loading, refreshing, load, remove, add } = useProjects(setToast);

  const q = query.trim().toLowerCase();
  const services = useMemo(() => {
    const list = q
      ? projects.filter((p) => `${p.name} ${p.repository_url} ${p.branch}`.toLowerCase().includes(q))
      : projects;
    return [...list].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  }, [projects, q]);

  const deployments = useMemo(() => toDeployments(services).filter((d) => (env === "production" ? true : d.env === "preview" || d.status === "building")), [services, env]);
  const domains = useMemo(() => toDomains(services), [services]);
  const featured = services[0];
  const live = deployments.find((d) => d.projectId === featured?.id) ?? deployments[0];

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
        counts={{ services: projects.length, deployments: deployments.length, domains: domains.length }}
        healthy={healthy}
      />
      <div className="min-w-0">
        <Topbar
          env={env}
          setEnv={setEnv}
          query={query}
          setQuery={setQuery}
          refreshing={refreshing}
          onRefresh={() => load()}
          onNew={() => {
            setFormError("");
            setModal(true);
          }}
          onDeploy={() => {
            setFormError("");
            setModal(true);
          }}
        />

        <main className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6">
          {nav === "overview" && (
            <>
              <ServiceHeader project={featured} live={live} />
              <MetricsRow projects={services} />
              <div className="grid items-start gap-3 xl:grid-cols-[1fr_320px]">
                <DeployTimeline deployments={deployments} onNew={() => setModal(true)} />
                <div className="flex flex-col gap-3">
                  <Panel>
                    <PanelHead title="Production" />
                    <div className="p-3.5 text-[13px]">
                      {live ? (
                        <>
                          <p className="truncate font-medium text-zinc-100">{live.message}</p>
                          <p className="mt-1 font-mono text-[11px] text-zinc-500">
                            {live.commit} on {live.branch} · {live.duration}
                          </p>
                        </>
                      ) : (
                        <p className="text-zinc-500">No production deploy yet.</p>
                      )}
                    </div>
                  </Panel>
                  <ResourceBars projects={services} />
                  <Panel>
                    <PanelHead title="Env preview" right={<span className="font-mono text-[11px] text-zinc-600">3 vars</span>} />
                    <div className="p-3.5 font-mono text-[11px] leading-5 text-zinc-500">
                      <p>DATABASE_URL=••••••</p>
                      <p>REDIS_URL=••••••</p>
                      <p>API_TOKEN=••••••</p>
                    </div>
                  </Panel>
                </div>
              </div>
            </>
          )}

          {nav === "services" && (
            <>
              <div className="flex items-end justify-between">
                <div>
                  <h1 className="text-lg font-semibold tracking-tight text-white">Services</h1>
                  <p className="text-[13px] text-zinc-500">{services.length} running · synced from git</p>
                </div>
              </div>
              <ServicesGrid
                projects={services}
                loading={loading}
                onNew={() => setModal(true)}
                onDelete={async (id) => {
                  await remove(id);
                  setToast("Service removed");
                }}
              />
            </>
          )}

          {nav === "deployments" && <DeploysTable deployments={deployments} />}
          {nav === "domains" && <DomainsView domains={domains} onNew={() => setModal(true)} />}
          {nav === "logs" && <LogsView lines={fakeLogs(featured?.name ?? "app")} service={featured?.name ?? "app"} />}
          {nav === "settings" && <SettingsView />}
        </main>
      </div>

      <ProjectModal open={modal} busy={creating} error={formError} onClose={() => setModal(false)} onSubmit={submit} />
      <Toast msg={toast} onClose={() => setToast(null)} />
    </div>
  );
}
