import type { ReactNode } from "react";

import {
  EFFECTIVE_FIELDS,
  FIELD_LABELS,
  configValue,
  isDraftField,
  sourceLabel,
} from "../lib/buildConfig";
import type {
  BuildConfig,
  Confidence,
  DetectionResponse,
  DetectionSuggestion,
  EffectiveBuildConfig,
} from "../lib/buildConfig";
import { cx } from "../lib/format";
import { QuietBtn } from "./ui";

export function DetectionResult({
  detection,
  onUseDetected,
  onApplySuggestion,
  onUseCandidate,
}: {
  detection: DetectionResponse;
  onUseDetected: () => void;
  onApplySuggestion: (suggestion: DetectionSuggestion) => void;
  onUseCandidate: (candidate: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {detection.explicitIssues.length > 0 && (
        <div role="alert" className="rounded-xl border border-amber-900/60 bg-amber-950/30 p-3">
          <h5 className="text-[11px] font-semibold tracking-[0.12em] text-amber-200 uppercase">
            Saved configuration issues at this commit
          </h5>
          <ul className="mt-1 list-disc pl-4 text-[12px] text-amber-200">
            {detection.explicitIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-amber-200/80">
            Your saved configuration was not changed.
          </p>
        </div>
      )}

      {detection.ambiguous && (
        <div role="status" className="rounded-xl border border-amber-900/60 bg-amber-950/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="amber">ambiguous</Badge>
            <span className="text-[12px] text-amber-200">{detection.ambiguous.message}</span>
            <code className="font-mono text-[10px] text-amber-300/80">
              {detection.ambiguous.code}
            </code>
          </div>
          <h5 className="mt-3 text-[11px] font-semibold tracking-[0.12em] text-amber-200 uppercase">
            Monorepo candidates
          </h5>
          {detection.ambiguous.candidates.length > 0 ? (
            <ul aria-label="Monorepo candidates" className="mt-2 flex flex-col gap-1.5">
              {detection.ambiguous.candidates.map((candidate) => (
                <li
                  key={candidate}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-ink-900 px-2.5 py-2"
                >
                  <code className="font-mono text-[12px] text-fog-100">{candidate}</code>
                  <QuietBtn
                    type="button"
                    className="ml-auto px-2 py-1 text-[11px]"
                    onClick={() => onUseCandidate(candidate)}
                  >
                    Use as application root
                  </QuietBtn>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[12px] text-amber-200/80">
              No candidate directories were returned.
            </p>
          )}
          <p className="mt-2 text-[11px] text-amber-200/80">
            No root was selected automatically. Choose one explicitly or save a configuration.
          </p>
        </div>
      )}

      {detection.unsupported && (
        <div role="alert" className="rounded-xl border border-red-900 bg-red-950/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="red">unsupported</Badge>
            <code className="font-mono text-[10px] text-red-200/80">
              {detection.unsupported.code}
            </code>
          </div>
          <p className="mt-1 text-[12px] text-red-200">{detection.unsupported.message}</p>
        </div>
      )}

      {detection.detected && (
        <div className="rounded-xl border border-edge bg-ink-950/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={confidenceTone(detection.detected.confidence)}>
              {detection.detected.confidence} confidence
            </Badge>
            {detection.detected.needsReview && <Badge tone="amber">review needed</Badge>}
            <span className="font-mono text-[11px] text-fog-500">
              {detection.detected.language} · {detection.detected.framework}
            </span>
          </div>

          <h5 className="mt-3 text-[11px] font-semibold tracking-[0.12em] text-fog-400 uppercase">
            Detected configuration
          </h5>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            <Fact label="Builder" value={detection.detected.config.builder} />
            <Fact label="Application root" value={detection.detected.config.applicationRoot} />
            <Fact label="Dockerfile path" value={detection.detected.config.dockerfilePath} />
            <Fact label="Build command" value={detection.detected.config.buildCommand} />
            <Fact label="Start command" value={detection.detected.config.startCommand} />
            <Fact label="Output directory" value={detection.detected.config.outputDirectory} />
          </dl>
          <p className="mt-1 text-[11px] text-fog-500">
            Commands are shown only when observed in the repository; other values may be
            documented defaults.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <QuietBtn type="button" onClick={onUseDetected}>
              Use detected settings in editor
            </QuietBtn>
            <span className="text-[11px] text-fog-500">
              Copies the detected baseline into the editor. Nothing is saved automatically.
            </span>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div>
              <h5 className="text-[11px] font-semibold tracking-[0.12em] text-fog-400 uppercase">
                Evidence (observed)
              </h5>
              {detection.detected.evidence.length > 0 ? (
                <ul aria-label="Evidence (observed)" className="mt-2 flex flex-col gap-1.5">
                  {detection.detected.evidence.map((item, index) => (
                    <li
                      key={`${item.file}-${item.type}-${index}`}
                      className="rounded-lg border border-edge bg-ink-900 px-2.5 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <code className="font-mono text-[11px] text-signal-300">{item.file}</code>
                        <Badge>{item.type}</Badge>
                      </div>
                      <p className="mt-1 text-[12px] text-fog-200">{item.fact}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[12px] text-fog-500">No evidence was returned.</p>
              )}
            </div>

            <div>
              <h5 className="text-[11px] font-semibold tracking-[0.12em] text-fog-400 uppercase">
                Suggestions (not applied)
              </h5>
              {detection.detected.suggestions.length > 0 ? (
                <ul aria-label="Suggestions (not applied)" className="mt-2 flex flex-col gap-1.5">
                  {detection.detected.suggestions.map((suggestion, index) => (
                    <li
                      key={`${suggestion.field}-${suggestion.value}-${index}`}
                      className="rounded-lg border border-edge bg-ink-900 px-2.5 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <code className="text-[11px] text-fog-400">
                          {isDraftField(suggestion.field)
                            ? FIELD_LABELS[suggestion.field]
                            : suggestion.field}
                        </code>
                        <span className="text-fog-500">=</span>
                        <code className="font-mono text-[12px] text-fog-100">
                          {suggestion.value}
                        </code>
                        <Badge tone={confidenceTone(suggestion.confidence)}>
                          {suggestion.confidence}
                        </Badge>
                        <QuietBtn
                          type="button"
                          aria-label={`Apply suggestion for ${suggestion.field}`}
                          className="ml-auto px-2 py-1 text-[11px]"
                          onClick={() => onApplySuggestion(suggestion)}
                        >
                          Apply
                        </QuietBtn>
                      </div>
                      <p className="mt-1 text-[12px] text-fog-400">{suggestion.basis}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[12px] text-fog-500">No suggestions were returned.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {detection.explicit && (
        <p className="text-[12px] text-fog-400">
          A saved configuration is active. Detection did not change it; the effective values below
          show which source wins.
        </p>
      )}

      {detection.effective && <EffectiveConfig effective={detection.effective} />}

      <p className="text-[11px] text-fog-500">
        Detected values stay informational until you save the configuration. Suggestions are
        proposals, not confirmed settings.
      </p>
    </div>
  );
}

function EffectiveConfig({ effective }: { effective: EffectiveBuildConfig }) {
  return (
    <div>
      <h5 className="text-[11px] font-semibold tracking-[0.12em] text-fog-400 uppercase">
        Effective configuration
      </h5>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        {EFFECTIVE_FIELDS.map((field) => (
          <div
            key={field}
            className="flex flex-col gap-0.5 rounded-lg border border-edge bg-ink-900 px-3 py-2"
          >
            <dt className="text-[10px] font-medium tracking-[0.12em] text-fog-500 uppercase">
              {FIELD_LABELS[field]}
            </dt>
            <dd className="flex items-center justify-between gap-2">
              <span className="font-mono text-[12px] break-all text-fog-100">
                {configValue(effective[field])}
              </span>
              <Badge tone={sourceTone(effective.sources[field])}>
                {sourceLabel(effective.sources[field])}
              </Badge>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-edge bg-ink-900 px-3 py-2">
      <dt className="text-[10px] font-medium tracking-[0.12em] text-fog-500 uppercase">
        {label}
      </dt>
      <dd className={cx("font-mono text-[12px] break-all", value ? "text-fog-100" : "text-fog-500")}>
        {configValue(value)}
      </dd>
    </div>
  );
}

type BadgeTone = "signal" | "amber" | "red" | "muted";

const BADGE_TONES: Record<BadgeTone, string> = {
  signal: "border-signal-500/40 bg-signal-950 text-signal-300",
  amber: "border-amber-900/60 bg-amber-950/30 text-amber-200",
  red: "border-red-900 bg-red-950/40 text-red-200",
  muted: "border-edge bg-ink-800 text-fog-500",
};

export function Badge({ tone = "muted", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium",
        BADGE_TONES[tone]
      )}
    >
      {children}
    </span>
  );
}

function confidenceTone(confidence: Confidence): BadgeTone {
  if (confidence === "high") return "signal";
  if (confidence === "medium") return "amber";
  return "muted";
}

function sourceTone(source: EffectiveBuildConfig["sources"][keyof BuildConfig]): BadgeTone {
  if (source === "detected") return "signal";
  if (source === "default") return "amber";
  return "muted";
}
