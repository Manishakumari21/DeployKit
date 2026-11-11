import {
  Check,
  Copy,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  enrollProjectAgent,
  fetchProjectAgents,
  revokeProjectAgent,
} from "../lib/api";
import { timeAgo } from "../lib/format";
import type { EnrolledAgentResponse, Project, ProjectAgent } from "../types";
import { DangerBtn, DeployBtn, EmptyState, Eyebrow, Panel, PanelHead, QuietBtn } from "./ui";

export function ServersView({
  project,
  onNotify,
}: {
  project?: Project;
  onNotify?: (message: string) => void;
}) {
  const [agents, setAgents] = useState<ProjectAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Enrollment modal state
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrolledResult, setEnrolledResult] = useState<EnrolledAgentResponse | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Revoke modal state
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const loadAgents = useCallback(
    async (projectId: string) => {
      setLoading(true);
      setError(null);
      try {
        const rows = await fetchProjectAgents(projectId);
        setAgents(Array.isArray(rows) ? rows : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load servers");
        setAgents([]);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (project?.id) {
      void loadAgents(project.id);
    } else {
      setAgents([]);
    }
  }, [project?.id, loadAgents]);

  if (!project) {
    return (
      <Panel>
        <PanelHead title="Servers & Edge Agents" />
        <EmptyState
          title="No service selected"
          body="Select a service from the fleet roster to manage its dedicated servers and edge nodes."
        />
      </Panel>
    );
  }

  const handleEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setEnrollError("Server / Agent name is required.");
      return;
    }
    setEnrolling(true);
    setEnrollError(null);
    try {
      const res = await enrollProjectAgent(project.id, name.trim());
      setEnrolledResult(res);
      setName("");
      void loadAgents(project.id);
      onNotify?.(`Agent "${res.agent.name}" enrolled`);
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : "Failed to enroll agent");
    } finally {
      setEnrolling(false);
    }
  };

  const handleRevoke = async (agentId: string) => {
    setRevoking(true);
    try {
      await revokeProjectAgent(project.id, agentId);
      setRevokingId(null);
      void loadAgents(project.id);
      onNotify?.("Agent credential revoked");
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : "Failed to revoke agent");
    } finally {
      setRevoking(false);
    }
  };

  const copyToClipboard = async (text: string, isToken: boolean) => {
    try {
      await navigator.clipboard.writeText(text);
      if (isToken) {
        setCopiedToken(true);
        setTimeout(() => setCopiedToken(false), 2000);
      } else {
        setCopiedCmd(true);
        setTimeout(() => setCopiedCmd(false), 2000);
      }
    } catch {
      onNotify?.("Failed to copy to clipboard");
    }
  };

  return (
    <div className="dk-stagger flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>Distributed Infrastructure</Eyebrow>
          <h1
            className="mt-1 text-2xl font-bold tracking-tight text-white"
            style={{ letterSpacing: "-0.02em" }}
          >
            Servers & Edge Agents
          </h1>
          <p className="mt-1 text-[13px] text-fog-500">
            Deploy workloads directly to your own Linux VPS, dedicated server, or edge host.
            Your agents connect back to this control plane over outbound HTTPS with zero incoming ports needed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <QuietBtn
            onClick={() => void loadAgents(project.id)}
            disabled={loading}
            aria-label="Refresh servers"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </QuietBtn>
          <DeployBtn onClick={() => setShowModal(true)}>
            <Plus size={14} />
            Enroll Server
          </DeployBtn>
        </div>
      </div>

      {/* Main Panel */}
      <Panel className="p-5">
        <PanelHead
          title={`Enrolled nodes for ${project.name}`}
          right={
            <span className="font-mono text-[11px] text-fog-500">
              {agents.length} {agents.length === 1 ? "node" : "nodes"}
            </span>
          }
        />

        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-red-900/40 bg-red-950/20 p-3 text-[13px] text-red-300">
            {error}
          </p>
        )}

        {loading && agents.length === 0 && (
          <p className="py-8 text-center font-mono text-[13px] text-fog-500">
            polling servers…
          </p>
        )}

        {!loading && agents.length === 0 && !error && (
          <div className="py-6">
            <EmptyState
              title="No remote servers connected"
              body="By default, deployments execute on your primary DeployKit host. You can enroll additional remote Linux servers by running the DeployKit agent daemon."
            />
            <div className="mt-4 flex justify-center">
              <DeployBtn onClick={() => setShowModal(true)}>
                <Plus size={14} />
                Connect Your First Remote Server
              </DeployBtn>
            </div>
          </div>
        )}

        {agents.length > 0 && (
          <ul className="mt-4 flex flex-col gap-3">
            {agents.map((agent) => {
              const isOnline = agent.status === "online";
              const isPending = agent.status === "pending";
              const isRevoked = agent.status === "revoked";

              return (
                <li
                  key={agent.id}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-edge bg-ink-900/60 p-4 transition duration-200 hover:border-fog-500/40"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`grid size-10 place-items-center rounded-lg border ${
                        isOnline
                          ? "border-signal-500/30 bg-signal-950/40 text-signal-400"
                          : isPending
                            ? "border-amber-500/30 bg-amber-950/40 text-amber-300"
                            : "border-edge bg-ink-950 text-fog-500"
                      }`}
                    >
                      <Server size={18} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">{agent.name}</span>
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${
                            isOnline
                              ? "border-signal-500/40 bg-signal-950/60 text-signal-300"
                              : isPending
                                ? "border-amber-500/40 bg-amber-950/60 text-amber-200"
                                : isRevoked
                                  ? "border-red-500/40 bg-red-950/60 text-red-300"
                                  : "border-edge bg-ink-800 text-fog-500"
                          }`}
                        >
                          <span
                            className={`size-1.5 rounded-full ${
                              isOnline
                                ? "animate-pulse bg-signal-400"
                                : isPending
                                  ? "bg-amber-300"
                                  : isRevoked
                                    ? "bg-red-400"
                                    : "bg-fog-500"
                            }`}
                          />
                          {agent.status}
                        </span>
                      </div>
                      <p className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-fog-500">
                        <span>ID: {agent.id.slice(0, 8)}</span>
                        <span>·</span>
                        <span>
                          Heartbeat:{" "}
                          {agent.lastHeartbeatAt ? timeAgo(agent.lastHeartbeatAt) : "never"}
                        </span>
                        {agent.version && (
                          <>
                            <span>·</span>
                            <span>v{agent.version}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {!isRevoked && (
                      <DangerBtn
                        onClick={() => setRevokingId(agent.id)}
                        disabled={revoking}
                        className="py-1.5 text-[12px]"
                      >
                        <Trash2 size={13} />
                        Revoke
                      </DangerBtn>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {/* Enrollment Dialog */}
      {showModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-xl rounded-2xl border border-edge bg-ink-900 p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-white">Enroll New Server Node</h2>
            <p className="mt-1 text-[13px] text-fog-500">
              Provide a human-readable identifier for your server. DeployKit generates a one-time cryptographic token and the exact Docker launch command.
            </p>

            {!enrolledResult ? (
              <form onSubmit={handleEnroll} className="mt-4 flex flex-col gap-4">
                <div>
                  <label htmlFor="agent-name" className="block text-[12px] font-medium text-fog-200">
                    Server / Node Name
                  </label>
                  <input
                    id="agent-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. hetzner-fsn-node1 or home-lab-worker"
                    className="mt-1.5 w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 text-[13px] text-white outline-none placeholder:text-fog-500 focus:border-signal-500"
                    disabled={enrolling}
                    autoFocus
                  />
                </div>

                {enrollError && (
                  <p role="alert" className="text-[13px] text-red-300">
                    {enrollError}
                  </p>
                )}

                <div className="mt-2 flex justify-end gap-2">
                  <QuietBtn type="button" onClick={() => setShowModal(false)} disabled={enrolling}>
                    Cancel
                  </QuietBtn>
                  <DeployBtn type="submit" disabled={enrolling || !name.trim()}>
                    {enrolling ? "Enrolling…" : "Generate Credentials"}
                  </DeployBtn>
                </div>
              </form>
            ) : (
              <div className="mt-4 flex flex-col gap-4">
                <div className="rounded-lg border border-amber-500/30 bg-amber-950/30 p-3 text-[12px] text-amber-200">
                  <p className="font-semibold">Save this token now:</p>
                  <p className="mt-0.5">
                    For security, DeployKit stores only the cryptographic hash of this credential. It cannot be recovered once this dialog is closed.
                  </p>
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-fog-200">
                    Agent Token (Secret)
                  </label>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      readOnly
                      value={enrolledResult.credential.token}
                      className="w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 font-mono text-[12px] text-signal-300 outline-none"
                    />
                    <QuietBtn
                      type="button"
                      onClick={() => void copyToClipboard(enrolledResult.credential.token, true)}
                    >
                      {copiedToken ? <Check size={14} className="text-signal-400" /> : <Copy size={14} />}
                      {copiedToken ? "Copied" : "Copy"}
                    </QuietBtn>
                  </div>
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-fog-200">
                    One-Line Installation Command (Run on remote server)
                  </label>
                  <div className="mt-1 flex items-center gap-2">
                    <textarea
                      readOnly
                      rows={4}
                      value={enrolledResult.installCommand}
                      className="w-full resize-none rounded-lg border border-edge bg-ink-950 p-2.5 font-mono text-[11px] leading-relaxed text-fog-200 outline-none"
                    />
                    <QuietBtn
                      type="button"
                      onClick={() => void copyToClipboard(enrolledResult.installCommand, false)}
                    >
                      {copiedCmd ? <Check size={14} className="text-signal-400" /> : <Copy size={14} />}
                      {copiedCmd ? "Copied" : "Copy"}
                    </QuietBtn>
                  </div>
                </div>

                <div className="mt-2 flex justify-end">
                  <DeployBtn
                    type="button"
                    onClick={() => {
                      setEnrolledResult(null);
                      setShowModal(false);
                    }}
                  >
                    Done
                  </DeployBtn>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Revoke Confirmation Dialog */}
      {revokingId && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-2xl border border-red-900/60 bg-ink-900 p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-red-400">
              <ShieldAlert size={24} />
              <h2 className="text-lg font-bold text-white">Revoke Agent Credential</h2>
            </div>
            <p className="mt-2 text-[13px] text-fog-400">
              Are you sure you want to revoke this server's credentials? The daemon running on that server will be immediately disconnected and can no longer execute deployments for this project.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <QuietBtn onClick={() => setRevokingId(null)} disabled={revoking}>
                Cancel
              </QuietBtn>
              <DangerBtn onClick={() => void handleRevoke(revokingId)} disabled={revoking}>
                {revoking ? "Revoking…" : "Revoke Server"}
              </DangerBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
