import { AlertTriangle, Check, Edit2, Eye, EyeOff, Lock, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  createProjectEnvVar,
  deleteProject,
  deleteProjectEnvVar,
  fetchProjectEnvVars,
  revealProjectEnvVar,
  updateProject,
  updateProjectEnvVar,
} from "../lib/api";
import type { Project, ProjectEnvVar } from "../types";
import { BuildConfigPanel } from "./BuildConfigPanel";
import { DangerBtn, DeployBtn, EmptyState, Eyebrow, Panel, PanelHead, QuietBtn } from "./ui";

const RESERVED_KEYS = new Set(["PORT", "DEPLOYKIT_DEPLOYMENT_ID"]);
const KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SettingsViewProps {
  project?: Project;
  onNotify?: (message: string) => void;
  onProjectUpdate?: () => void | Promise<void>;
  onProjectDelete?: (id: string) => void | Promise<void>;
}

export function SettingsView({
  project,
  onNotify,
  onProjectUpdate,
  onProjectDelete,
}: SettingsViewProps) {
  // Identity state
  const [name, setName] = useState(project?.name ?? "");
  const [branch, setBranch] = useState(project?.branch ?? "main");
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [identitySuccess, setIdentitySuccess] = useState(false);

  // Env vars state
  const [envVars, setEnvVars] = useState<ProjectEnvVar[]>([]);
  const [loadingEnv, setLoadingEnv] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);

  // New env var form state
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newIsSecret, setNewIsSecret] = useState(true);
  const [addingVar, setAddingVar] = useState(false);
  const [addVarError, setAddVarError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Edit env var state
  const [editingVarId, setEditingVarId] = useState<string | null>(null);
  const [editKey, setEditKey] = useState("");
  const [editValue, setEditValue] = useState("");
  const [editIsSecret, setEditIsSecret] = useState(false);
  const [savingVar, setSavingVar] = useState(false);
  const [editVarError, setEditVarError] = useState<string | null>(null);

  // Delete workspace dialog state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState("");
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Secret reveal state
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [revealingId, setRevealingId] = useState<string | null>(null);

  const toggleRevealSecret = async (varId: string) => {
    if (!project?.id) return;
    if (revealedSecrets[varId]) {
      setRevealedSecrets((prev) => {
        const next = { ...prev };
        delete next[varId];
        return next;
      });
      return;
    }
    setRevealingId(varId);
    try {
      const res = await revealProjectEnvVar(project.id, varId);
      setRevealedSecrets((prev) => ({ ...prev, [varId]: res.value }));
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : "Failed to reveal secret");
    } finally {
      setRevealingId(null);
    }
  };

  // Reset identity when project changes
  useEffect(() => {
    setName(project?.name ?? "");
    setBranch(project?.branch ?? "main");
    setIdentityError(null);
    setIdentitySuccess(false);
  }, [project?.id, project?.name, project?.branch]);

  // Load env vars
  const loadEnvVars = useCallback(async (projectId: string) => {
    setLoadingEnv(true);
    setEnvError(null);
    try {
      const vars = await fetchProjectEnvVars(projectId);
      setEnvVars(vars);
    } catch (err) {
      setEnvError(err instanceof Error ? err.message : "Failed to load environment variables");
    } finally {
      setLoadingEnv(false);
    }
  }, []);

  useEffect(() => {
    if (project?.id) {
      void loadEnvVars(project.id);
    } else {
      setEnvVars([]);
    }
  }, [project?.id, loadEnvVars]);

  if (!project) {
    return (
      <Panel>
        <PanelHead title="Settings" />
        <EmptyState
          title="No workspace selected"
          body="Select a workspace to manage its settings and environment variables."
        />
      </Panel>
    );
  }

  // Handle identity update
  const handleSaveIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;

    const trimmedName = name.trim();
    const trimmedBranch = branch.trim();

    if (!trimmedName || trimmedName.length > 100) {
      setIdentityError("Workspace name must be between 1 and 100 characters");
      return;
    }
    if (!trimmedBranch) {
      setIdentityError("Default branch cannot be empty");
      return;
    }

    setSavingIdentity(true);
    setIdentityError(null);
    setIdentitySuccess(false);

    try {
      await updateProject(project.id, {
        name: trimmedName,
        branch: trimmedBranch,
      });
      setIdentitySuccess(true);
      onNotify?.("Workspace settings updated");
      if (onProjectUpdate) {
        await onProjectUpdate();
      }
      setTimeout(() => setIdentitySuccess(false), 3000);
    } catch (err) {
      setIdentityError(err instanceof Error ? err.message : "Failed to update workspace settings");
    } finally {
      setSavingIdentity(false);
    }
  };

  // Handle add env var
  const handleAddEnvVar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;

    const key = newKey.trim();
    if (!key) {
      setAddVarError("Variable key is required");
      return;
    }
    if (!KEY_REGEX.test(key)) {
      setAddVarError("Key must start with a letter/underscore and contain only alphanumeric characters and underscores");
      return;
    }
    if (RESERVED_KEYS.has(key.toUpperCase())) {
      setAddVarError(`'${key}' is a reserved environment variable`);
      return;
    }

    setAddingVar(true);
    setAddVarError(null);

    try {
      const created = await createProjectEnvVar(project.id, {
        key,
        value: newValue,
        isSecret: newIsSecret,
      });
      setEnvVars((prev) => [...prev, created].sort((a, b) => a.key.localeCompare(b.key)));
      setNewKey("");
      setNewValue("");
      setNewIsSecret(true);
      setShowAddForm(false);
      onNotify?.(`Added ${created.key}`);
    } catch (err) {
      setAddVarError(err instanceof Error ? err.message : "Failed to add environment variable");
    } finally {
      setAddingVar(false);
    }
  };

  // Start editing a var
  const startEditVar = (v: ProjectEnvVar) => {
    setEditingVarId(v.id);
    setEditKey(v.key);
    setEditValue(v.value);
    setEditIsSecret(v.is_secret);
    setEditVarError(null);
  };

  // Save edited var
  const handleSaveEditVar = async (varId: string) => {
    if (!project) return;
    const key = editKey.trim();
    if (!key) {
      setEditVarError("Key is required");
      return;
    }
    if (!KEY_REGEX.test(key)) {
      setEditVarError("Invalid key format");
      return;
    }
    if (RESERVED_KEYS.has(key.toUpperCase())) {
      setEditVarError(`'${key}' is reserved`);
      return;
    }

    setSavingVar(true);
    setEditVarError(null);

    try {
      const updated = await updateProjectEnvVar(project.id, varId, {
        key,
        value: editValue,
        isSecret: editIsSecret,
      });
      setEnvVars((prev) =>
        prev.map((v) => (v.id === varId ? updated : v)).sort((a, b) => a.key.localeCompare(b.key))
      );
      setEditingVarId(null);
      onNotify?.(`Updated ${updated.key}`);
    } catch (err) {
      setEditVarError(err instanceof Error ? err.message : "Failed to update variable");
    } finally {
      setSavingVar(false);
    }
  };

  // Delete env var
  const handleDeleteEnvVar = async (varId: string, varKey: string) => {
    if (!project) return;
    try {
      await deleteProjectEnvVar(project.id, varId);
      setEnvVars((prev) => prev.filter((v) => v.id !== varId));
      onNotify?.(`Deleted ${varKey}`);
    } catch (err) {
      setEnvError(err instanceof Error ? err.message : "Failed to delete variable");
    }
  };

  // Handle workspace deletion
  const handleDeleteWorkspace = async () => {
    if (!project || deleteConfirmationText !== project.name) return;

    setDeletingWorkspace(true);
    setDeleteError(null);

    try {
      if (onProjectDelete) {
        await onProjectDelete(project.id);
      } else {
        await deleteProject(project.id);
      }
      setDeleteModalOpen(false);
      onNotify?.("Workspace deleted");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete workspace");
      setDeletingWorkspace(false);
    }
  };

  const identityChanged =
    name.trim() !== project.name || branch.trim() !== project.branch;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <BuildConfigPanel key={project.id} project={project} onNotify={onNotify} />

      {/* Workspace Identity Settings */}
      <Panel>
        <PanelHead title="Workspace" />
        <form onSubmit={handleSaveIdentity} className="flex flex-col gap-3 p-4 text-[13px]">
          <Eyebrow>Identity</Eyebrow>
          <label className="flex flex-col gap-1 font-medium text-fog-200">
            Workspace name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="acme-prod"
              maxLength={100}
              required
              disabled={savingIdentity}
              className="rounded-lg border border-edge bg-ink-950 px-3 py-2 text-fog-100 outline-none focus:border-signal-500 disabled:opacity-60"
            />
          </label>
          <label className="flex flex-col gap-1 font-medium text-fog-200">
            Default branch
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              maxLength={100}
              required
              disabled={savingIdentity}
              className="rounded-lg border border-edge bg-ink-950 px-3 py-2 font-mono text-fog-100 outline-none focus:border-signal-500 disabled:opacity-60"
            />
          </label>

          {identityError && (
            <p role="alert" className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[12px] text-red-200">
              {identityError}
            </p>
          )}

          {identitySuccess && (
            <p className="flex items-center gap-1.5 rounded-lg border border-signal-900/40 bg-signal-950/30 px-3 py-2 text-[12px] text-signal-300">
              <Check size={14} /> Workspace settings saved
            </p>
          )}

          <div className="mt-1 flex items-center justify-end gap-2">
            <DeployBtn
              type="submit"
              disabled={savingIdentity || !identityChanged || !name.trim() || !branch.trim()}
            >
              {savingIdentity ? "Saving…" : "Save changes"}
            </DeployBtn>
          </div>
        </form>
      </Panel>

      {/* Environment Variables */}
      <Panel className="lg:col-span-2">
        <PanelHead
          title="Environment"
          right={
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-fog-500">.env · AES-256-GCM sealed</span>
              <button
                type="button"
                onClick={() => setShowAddForm(!showAddForm)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-edge bg-ink-800 px-2 py-1 text-[11px] font-medium text-fog-200 transition hover:border-fog-500 hover:text-white"
              >
                <Plus size={12} /> Add variable
              </button>
            </div>
          }
        />

        <div className="p-4">
          {/* Add variable form */}
          {showAddForm && (
            <form
              onSubmit={handleAddEnvVar}
              className="mb-4 rounded-xl border border-edge bg-ink-950/80 p-3.5 text-[12px]"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold text-fog-200">New environment variable</span>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="cursor-pointer text-fog-500 hover:text-white"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-fog-300">
                  Key
                  <input
                    type="text"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value.toUpperCase())}
                    placeholder="API_KEY"
                    required
                    disabled={addingVar}
                    className="rounded-lg border border-edge bg-ink-900 px-3 py-1.5 font-mono text-fog-100 outline-none focus:border-signal-500"
                  />
                </label>
                <label className="flex flex-col gap-1 text-fog-300">
                  Value
                  <input
                    type={newIsSecret ? "password" : "text"}
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    placeholder="value"
                    disabled={addingVar}
                    className="rounded-lg border border-edge bg-ink-900 px-3 py-1.5 font-mono text-fog-100 outline-none focus:border-signal-500"
                  />
                </label>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-fog-300">
                  <input
                    type="checkbox"
                    checked={newIsSecret}
                    onChange={(e) => setNewIsSecret(e.target.checked)}
                    className="size-4 rounded border-edge bg-ink-900 text-signal-500"
                  />
                  <span>Encrypt as secret (value masked in UI)</span>
                </label>
                <div className="flex gap-2">
                  <QuietBtn
                    type="button"
                    onClick={() => setShowAddForm(false)}
                    disabled={addingVar}
                    className="py-1 text-[12px]"
                  >
                    Cancel
                  </QuietBtn>
                  <DeployBtn type="submit" disabled={addingVar || !newKey.trim()} className="py-1 text-[12px]">
                    {addingVar ? "Adding…" : "Add"}
                  </DeployBtn>
                </div>
              </div>

              {addVarError && (
                <p role="alert" className="mt-2 text-red-300">
                  {addVarError}
                </p>
              )}
            </form>
          )}

          {envError && (
            <p role="alert" className="mb-3 rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[12px] text-red-200">
              {envError}
            </p>
          )}

          {loadingEnv && (
            <div className="flex items-center gap-2 py-4 text-[12px] text-fog-500">
              <RefreshCw size={13} className="animate-spin-slower text-signal-300" />
              Loading environment variables…
            </div>
          )}

          {!loadingEnv && envVars.length === 0 && !showAddForm && (
            <div className="rounded-xl border border-dashed border-edge p-6 text-center text-[12px] text-fog-500">
              No custom environment variables configured. Click &ldquo;Add variable&rdquo; to inject runtime variables.
            </div>
          )}

          {!loadingEnv && envVars.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-[12px]">
                <thead>
                  <tr className="border-b border-edge/50 text-[10px] uppercase tracking-wider text-fog-500">
                    <th className="px-3 py-2">Variable</th>
                    <th className="px-3 py-2">Value</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge/50">
                  {envVars.map((v) => {
                    const isEditing = editingVarId === v.id;

                    if (isEditing) {
                      return (
                        <tr key={v.id} className="bg-ink-950/60">
                          <td className="px-3 py-2 align-middle">
                            <input
                              type="text"
                              value={editKey}
                              onChange={(e) => setEditKey(e.target.value.toUpperCase())}
                              className="w-full rounded border border-edge bg-ink-900 px-2 py-1 text-fog-100 outline-none focus:border-signal-500"
                            />
                          </td>
                          <td className="px-3 py-2 align-middle">
                            <input
                              type={editIsSecret ? "password" : "text"}
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              placeholder={v.is_secret ? "Leave as •••••••• to keep secret" : "value"}
                              className="w-full rounded border border-edge bg-ink-900 px-2 py-1 text-fog-100 outline-none focus:border-signal-500"
                            />
                            {editVarError && <p className="mt-1 text-[11px] text-red-300">{editVarError}</p>}
                          </td>
                          <td className="px-3 py-2 align-middle">
                            <label className="flex items-center gap-1.5 text-fog-300">
                              <input
                                type="checkbox"
                                checked={editIsSecret}
                                onChange={(e) => setEditIsSecret(e.target.checked)}
                                className="size-3.5 rounded"
                              />
                              <span className="text-[11px]">Secret</span>
                            </label>
                          </td>
                          <td className="px-3 py-2 text-right align-middle">
                            <div className="flex items-center justify-end gap-1.5">
                              <QuietBtn
                                onClick={() => setEditingVarId(null)}
                                disabled={savingVar}
                                className="px-2 py-0.5 text-[11px]"
                              >
                                Cancel
                              </QuietBtn>
                              <DeployBtn
                                onClick={() => void handleSaveEditVar(v.id)}
                                disabled={savingVar}
                                className="px-2 py-0.5 text-[11px]"
                              >
                                {savingVar ? "Saving…" : "Save"}
                              </DeployBtn>
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    return (
                      <tr key={v.id} className="hover:bg-ink-950/40">
                        <td className="px-3 py-2.5 font-semibold text-fog-100">{v.key}</td>
                        <td className="px-3 py-2.5 text-fog-400">
                          {v.is_secret ? (
                            <div className="flex items-center gap-2">
                              <span className="flex items-center gap-1.5 text-fog-400 font-mono text-[12px]">
                                <Lock size={12} className="text-amber-400/80 shrink-0" />
                                <span>{revealedSecrets[v.id] ?? v.value}</span>
                              </span>
                              <button
                                type="button"
                                onClick={() => void toggleRevealSecret(v.id)}
                                disabled={revealingId === v.id}
                                title={revealedSecrets[v.id] ? "Hide secret" : "Reveal secret"}
                                aria-label={revealedSecrets[v.id] ? "Hide secret" : "Reveal secret"}
                                className="cursor-pointer rounded p-1 text-fog-500 hover:bg-ink-800 hover:text-white"
                              >
                                {revealedSecrets[v.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                              </button>
                            </div>
                          ) : (
                            <span className="truncate">{v.value}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {v.is_secret ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-950/40 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                              Secret
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-edge bg-ink-900 px-2 py-0.5 text-[10px] font-medium text-fog-400">
                              Plaintext
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => startEditVar(v)}
                              aria-label={`Edit ${v.key}`}
                              className="cursor-pointer rounded p-1 text-fog-400 hover:bg-ink-800 hover:text-white"
                            >
                              <Edit2 size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteEnvVar(v.id, v.key)}
                              aria-label={`Delete ${v.key}`}
                              className="cursor-pointer rounded p-1 text-fog-400 hover:bg-red-950/60 hover:text-red-300"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>

      {/* Danger Zone */}
      <Panel className="border-red-900/60 lg:col-span-2">
        <PanelHead title="Danger zone" />
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-[13px]">
          <div>
            <p className="font-semibold text-red-200">Delete this workspace</p>
            <p className="mt-0.5 text-fog-400">
              Permanently delete this workspace and all associated services, deployments, releases, and environment variables.
            </p>
          </div>
          <DangerBtn
            onClick={() => {
              setDeleteConfirmationText("");
              setDeleteError(null);
              setDeleteModalOpen(true);
            }}
          >
            Delete workspace
          </DangerBtn>
        </div>
      </Panel>

      {/* Workspace Deletion Safety Modal */}
      {deleteModalOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-ink-950/80 p-4 backdrop-blur-sm"
          onClick={() => !deletingWorkspace && setDeleteModalOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md animate-rise rounded-2xl border border-red-900/80 bg-ink-900 p-5 shadow-2xl"
          >
            <div className="mb-3 flex items-start gap-3">
              <div className="rounded-full bg-red-950/80 p-2 text-red-400 border border-red-800/60">
                <AlertTriangle size={20} />
              </div>
              <div className="flex-1">
                <h3 className="text-[15px] font-bold text-white">Delete workspace</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-fog-300">
                  This action <strong className="text-red-300">cannot be undone</strong>. This will permanently decommission{" "}
                  <span className="font-semibold text-white">{project.name}</span> and delete all associated deployments,
                  runtime containers, and secrets.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDeleteModalOpen(false)}
                disabled={deletingWorkspace}
                className="cursor-pointer text-fog-500 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <label className="text-[12px] text-fog-300">
                To confirm, type <strong className="font-mono text-white">{project.name}</strong> below:
              </label>
              <input
                type="text"
                autoFocus
                value={deleteConfirmationText}
                onChange={(e) => setDeleteConfirmationText(e.target.value)}
                placeholder={project.name}
                disabled={deletingWorkspace}
                className="w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 font-mono text-[13px] text-fog-100 outline-none focus:border-red-500"
              />
            </div>

            {deleteError && (
              <p role="alert" className="mt-3 rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[12px] text-red-200">
                {deleteError}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <QuietBtn
                type="button"
                onClick={() => setDeleteModalOpen(false)}
                disabled={deletingWorkspace}
              >
                Cancel
              </QuietBtn>
              <DangerBtn
                type="button"
                disabled={deletingWorkspace || deleteConfirmationText !== project.name}
                onClick={() => void handleDeleteWorkspace()}
              >
                {deletingWorkspace ? "Deleting…" : "Permanently delete workspace"}
              </DangerBtn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
