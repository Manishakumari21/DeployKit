import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, RotateCcw, Save, Search } from "lucide-react";

import {
  ApiError,
  detectProject,
  fetchBuildConfig,
  resetBuildConfig,
  saveBuildConfig,
} from "../lib/api";
import {
  BUILDER_LABELS,
  BUILDERS,
  FIELD_LABELS,
  draftFromConfig,
  draftToBuildConfig,
  emptyDraft,
  fieldErrorFromMessage,
  isBuilder,
  isDraftField,
  validateDraft,
} from "../lib/buildConfig";
import type {
  BuildConfig,
  DetectionResponse,
  DetectionSuggestion,
  DraftBuildConfig,
  FieldErrors,
} from "../lib/buildConfig";
import { describeApiError, isAbortError } from "../lib/errors";
import { cx, timeAgo } from "../lib/format";
import type { Project } from "../types";
import { Badge, DetectionResult } from "./BuildDetectionResult";
import { DeployBtn, EmptyState, Panel, PanelHead, QuietBtn } from "./ui";

const INPUT =
  "w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 text-[13px] text-fog-100 shadow-[inset_0_1px_0_rgb(194_220_245/0.05)] outline-none placeholder:text-fog-500 focus:border-signal-500 disabled:opacity-50";

const SECONDARY =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-edge bg-ink-800 px-3 py-2 text-[12px] font-medium text-fog-200 transition duration-200 hover:border-fog-500 hover:text-white active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

export function BuildConfigPanel({
  project,
  onNotify,
}: {
  project?: Project;
  onNotify?: (message: string) => void;
}) {
  const projectId = project?.id ?? null;
  const [loading, setLoading] = useState(Boolean(projectId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<BuildConfig | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftBuildConfig>(emptyDraft);
  const [dirty, setDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<DetectionResponse | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const loadAbort = useRef<AbortController | null>(null);
  const detectAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchBuildConfig(projectId, controller.signal);
      setSaved(data.config);
      setUpdatedAt(data.updatedAt);
      setDraft(data.config ? draftFromConfig(data.config) : emptyDraft());
      setDirty(false);
      setFieldErrors({});
      setSaveError(null);
    } catch (error) {
      if (isAbortError(error)) return;
      setLoadError(describeApiError(error, "Could not load the build configuration."));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      loadAbort.current?.abort();
      detectAbort.current?.abort();
    };
  }, [projectId, load]);

  useEffect(() => {
    if (!confirmReset) return;
    const timer = setTimeout(() => setConfirmReset(false), 5000);
    return () => clearTimeout(timer);
  }, [confirmReset]);

  const update = (field: keyof DraftBuildConfig, value: string) => {
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === "builder" && value !== "dockerfile" ? { dockerfilePath: "" } : {}),
    }));
    setDirty(true);
    setFieldErrors((current) => {
      if (!current[field] && !(field === "builder" && current.dockerfilePath)) return current;
      const next = { ...current };
      delete next[field];
      if (field === "builder") delete next.dockerfilePath;
      return next;
    });
    setSaveError(null);
    setNotice(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectId || saving) return;
    const errors = validateDraft(draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || !isBuilder(draft.builder)) {
      setSaveError(null);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const config = draftToBuildConfig(draft);
      await saveBuildConfig(projectId, config);
      await load();
      setDetection(null);
      setDetectError(null);
      setNotice(
        config.builder === "dockerfile"
          ? "Build configuration saved. Future deployments will use it."
          : "Build configuration saved. The pipeline still only executes the Dockerfile builder."
      );
      onNotify?.("Build configuration saved");
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        const described = fieldErrorFromMessage(error.message);
        if (described.field) {
          setFieldErrors({ [described.field]: described.message });
          return;
        }
      }
      setSaveError(describeApiError(error, "Could not save the build configuration."));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!projectId || resetting) return;
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    setSaveError(null);
    setNotice(null);
    try {
      await resetBuildConfig(projectId);
      await load();
      setDetection(null);
      setDetectError(null);
      setNotice("Saved override removed. Automatic detection is active again.");
      onNotify?.("Build configuration reset to automatic detection");
    } catch (error) {
      setSaveError(describeApiError(error, "Could not reset the build configuration."));
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  };

  const detect = async () => {
    if (!projectId || detecting) return;
    detectAbort.current?.abort();
    const controller = new AbortController();
    detectAbort.current = controller;
    setDetection(null);
    setDetecting(true);
    setDetectError(null);
    try {
      const response = await detectProject(projectId, controller.signal);
      setDetection(response);
    } catch (error) {
      if (isAbortError(error)) return;
      setDetectError(describeApiError(error, "Detection failed. Try again."));
    } finally {
      if (!controller.signal.aborted) setDetecting(false);
    }
  };

  const useDetected = () => {
    if (!detection?.detected) return;
    setDraft(draftFromConfig(detection.detected.config));
    setDirty(true);
    setFieldErrors({});
    setSaveError(null);
    setNotice("Detected settings copied into the editor. Review and save to apply them.");
  };

  const applySuggestion = (suggestion: DetectionSuggestion) => {
    if (!isDraftField(suggestion.field)) return;
    update(suggestion.field, suggestion.value);
    setNotice(
      `Suggestion copied into ${FIELD_LABELS[suggestion.field]}. Review and save to apply it.`
    );
  };

  const useCandidate = (candidate: string) => {
    update("applicationRoot", candidate);
    setNotice(`Candidate "${candidate}" copied into the application root. Review and save.`);
  };

  if (!project) {
    return (
      <Panel className="lg:col-span-2">
        <PanelHead title="Build & detection" />
        <EmptyState
          title="No service selected"
          body="Choose a service to review how DeployKit detects and builds it."
        />
      </Panel>
    );
  }

  return (
    <Panel className="lg:col-span-2">
      <PanelHead
        title="Build & detection"
        right={<span className="font-mono text-[11px] text-fog-500">{project.name}</span>}
      />
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-2 rounded-xl border border-edge bg-ink-950/50 px-3 py-2.5 text-[12px] leading-relaxed text-fog-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" />
          <p>
            Detection reads repository files only and is read-only. Saving configuration changes
            future builds; neither action deploys your service.
          </p>
        </div>

        {loading && (
          <p role="status" className="font-mono text-[12px] text-fog-500">
            Loading build configuration…
          </p>
        )}

        {!loading && loadError && (
          <ErrorNotice message={loadError} onRetry={() => void load()} />
        )}

        {!loading && !loadError && (
          <>
            <section aria-labelledby="saved-config-heading" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h4 id="saved-config-heading" className="text-[13px] font-semibold text-white">
                  Saved configuration
                </h4>
                {saved ? (
                  <Badge tone="signal">saved override</Badge>
                ) : (
                  <Badge tone="muted">automatic detection</Badge>
                )}
                {updatedAt && timeAgo(updatedAt) && (
                  <span className="font-mono text-[11px] text-fog-500">
                    updated {timeAgo(updatedAt)}
                  </span>
                )}
                {dirty && <Badge tone="amber">unsaved changes</Badge>}
              </div>

              {!saved && (
                <p className="text-[12px] text-fog-500">
                  No saved configuration. Automatic detection is active. Only the Dockerfile
                  builder is executed by the deployment pipeline today.
                </p>
              )}
              <p className="text-[11px] text-fog-500">
                Saving validates the configuration fields. Run detection to check saved paths
                against this commit.
              </p>

              <form
                onSubmit={save}
                aria-label="Build configuration"
                className="grid gap-3 sm:grid-cols-2"
                noValidate
              >
                <Field
                  id="applicationRoot"
                  label="Application root"
                  hint='Use "." for the repository root.'
                  error={fieldErrors.applicationRoot}
                >
                  <input
                    id="applicationRoot"
                    className={cx(INPUT, "font-mono")}
                    value={draft.applicationRoot}
                    onChange={(event) => update("applicationRoot", event.target.value)}
                    placeholder="."
                    autoComplete="off"
                    aria-invalid={!!fieldErrors.applicationRoot}
                    aria-describedby={
                      fieldErrors.applicationRoot
                        ? "applicationRoot-error"
                        : "applicationRoot-hint"
                    }
                  />
                </Field>

                <Field
                  id="builder"
                  label="Builder"
                  hint="Only Dockerfile is deployed today; other builders are saved for review."
                  error={fieldErrors.builder}
                >
                  <select
                    id="builder"
                    className={INPUT}
                    value={draft.builder}
                    onChange={(event) => update("builder", event.target.value)}
                    aria-invalid={!!fieldErrors.builder}
                    aria-describedby={
                      fieldErrors.builder ? "builder-error" : "builder-hint"
                    }
                  >
                    <option value="">Select a builder…</option>
                    {BUILDERS.map((builder) => (
                      <option key={builder} value={builder}>
                        {BUILDER_LABELS[builder]}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  id="dockerfilePath"
                  label="Dockerfile path"
                  hint="Required for the Dockerfile builder."
                  error={fieldErrors.dockerfilePath}
                >
                  <input
                    id="dockerfilePath"
                    className={cx(INPUT, "font-mono")}
                    value={draft.dockerfilePath}
                    onChange={(event) => update("dockerfilePath", event.target.value)}
                    placeholder="Dockerfile"
                    autoComplete="off"
                    disabled={draft.builder !== "dockerfile"}
                    aria-invalid={!!fieldErrors.dockerfilePath}
                    aria-describedby={
                      fieldErrors.dockerfilePath
                        ? "dockerfilePath-error"
                        : "dockerfilePath-hint"
                    }
                  />
                </Field>

                <Field
                  id="outputDirectory"
                  label="Output directory"
                  hint="Optional. Leave blank if the builder does not need one."
                  error={fieldErrors.outputDirectory}
                >
                  <input
                    id="outputDirectory"
                    className={cx(INPUT, "font-mono")}
                    value={draft.outputDirectory}
                    onChange={(event) => update("outputDirectory", event.target.value)}
                    placeholder="dist"
                    autoComplete="off"
                    aria-invalid={!!fieldErrors.outputDirectory}
                    aria-describedby={
                      fieldErrors.outputDirectory
                        ? "outputDirectory-error"
                        : "outputDirectory-hint"
                    }
                  />
                </Field>

                <Field
                  id="buildCommand"
                  label="Build command"
                  hint="Optional. Shown only when detected in the repository."
                  error={fieldErrors.buildCommand}
                  className="sm:col-span-2"
                >
                  <input
                    id="buildCommand"
                    className={cx(INPUT, "font-mono")}
                    value={draft.buildCommand}
                    onChange={(event) => update("buildCommand", event.target.value)}
                    placeholder="npm run build"
                    autoComplete="off"
                    aria-invalid={!!fieldErrors.buildCommand}
                    aria-describedby={
                      fieldErrors.buildCommand ? "buildCommand-error" : "buildCommand-hint"
                    }
                  />
                </Field>

                <Field
                  id="startCommand"
                  label="Start command"
                  hint="Optional. Shown only when detected in the repository."
                  error={fieldErrors.startCommand}
                  className="sm:col-span-2"
                >
                  <input
                    id="startCommand"
                    className={cx(INPUT, "font-mono")}
                    value={draft.startCommand}
                    onChange={(event) => update("startCommand", event.target.value)}
                    placeholder="npm start"
                    autoComplete="off"
                    aria-invalid={!!fieldErrors.startCommand}
                    aria-describedby={
                      fieldErrors.startCommand ? "startCommand-error" : "startCommand-hint"
                    }
                  />
                </Field>

                {draft.builder !== "" && draft.builder !== "dockerfile" && (
                  <p
                    role="status"
                    className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[12px] text-amber-200 sm:col-span-2"
                  >
                    {BUILDER_LABELS[draft.builder as keyof typeof BUILDER_LABELS]} is not executed
                    by the deployment pipeline yet. Saving this configuration will not enable it.
                  </p>
                )}

                {notice && (
                  <p
                    role="status"
                    className="flex items-start gap-2 rounded-lg border border-signal-500/40 bg-signal-950/50 px-3 py-2 text-[12px] text-signal-200 sm:col-span-2"
                  >
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                    {notice}
                  </p>
                )}

                {saveError && (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[12px] text-red-200 sm:col-span-2"
                  >
                    {saveError}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                  <DeployBtn type="submit" disabled={saving || resetting}>
                    <Save size={14} />
                    {saving ? "Saving…" : "Save configuration"}
                  </DeployBtn>
                  {saved && (
                    <QuietBtn
                      type="button"
                      onClick={() => void reset()}
                      disabled={saving || resetting}
                      className={confirmReset ? "border-red-900 text-red-200" : undefined}
                    >
                      <RotateCcw size={14} />
                      {resetting
                        ? "Resetting…"
                        : confirmReset
                          ? "Confirm reset"
                          : "Reset to automatic detection"}
                    </QuietBtn>
                  )}
                  {confirmReset && (
                    <span className="text-[12px] text-red-300">
                      Removes the saved override and restores detection. It does not deploy.
                    </span>
                  )}
                </div>
              </form>
            </section>

            <section
              aria-labelledby="detection-heading"
              className="flex flex-col gap-3 border-t border-edge pt-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h4 id="detection-heading" className="text-[13px] font-semibold text-white">
                  Detection
                </h4>
                <button
                  type="button"
                  onClick={() => void detect()}
                  disabled={detecting}
                  className={SECONDARY}
                >
                  <Search size={14} />
                  {detecting ? "Scanning repository…" : "Detect project settings"}
                </button>
                {detection && (
                  <span className="font-mono text-[11px] text-fog-500">
                    commit {detection.commitSha.slice(0, 7)}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-fog-500">
                Detection returns observations from the repository. It never saves settings or
                triggers a deployment.
              </p>

              {detecting && (
                <p role="status" className="font-mono text-[12px] text-fog-500">
                  Scanning repository…
                </p>
              )}
              {!detecting && detectError && (
                <ErrorNotice message={detectError} onRetry={() => void detect()} />
              )}
              {!detecting && detection && (
                <DetectionResult
                  detection={detection}
                  onUseDetected={useDetected}
                  onApplySuggestion={applySuggestion}
                  onUseCandidate={useCandidate}
                />
              )}
              {!detecting && !detection && !detectError && (
                <p className="text-[12px] text-fog-500">
                  Run detection to see the language, framework, builder, commands, evidence, and
                  suggestions for this commit.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </Panel>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-[12px] font-medium text-fog-200">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[11px] text-fog-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-[11px] text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[12px] text-red-200"
    >
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className={cx(SECONDARY, "ml-auto px-2 py-1 text-[11px]")}>
          Retry
        </button>
      )}
    </div>
  );
}

