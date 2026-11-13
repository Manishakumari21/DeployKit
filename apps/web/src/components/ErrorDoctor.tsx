import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Lightbulb,
  RotateCcw,
  ScrollText,
  Sliders,
  Stethoscope,
} from "lucide-react";
import { cx } from "../lib/format";
import { diagnoseDeploymentError } from "../lib/errorDoctor";
import type { NavKey } from "../types";

export function ErrorDoctor({
  errorCode,
  errorMessage,
  onNavigate,
  onRetry,
}: {
  errorCode: string | null | undefined;
  errorMessage: string | null | undefined;
  onNavigate?: (tab: NavKey) => void;
  onRetry?: () => void;
}) {
  const diagnosis = diagnoseDeploymentError(errorCode, errorMessage);
  const [activeSnippetIdx, setActiveSnippetIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const snippets = diagnosis.snippets ?? [];
  const currentSnippet = snippets[activeSnippetIdx];

  const handleCopy = () => {
    if (!currentSnippet) return;
    navigator.clipboard?.writeText(currentSnippet.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-amber-500/30 bg-gradient-to-b from-amber-950/25 via-ink-900/40 to-ink-950/80 p-4 text-[13px] shadow-[0_8px_30px_rgb(0_0_0/0.3)]">
      {/* Header Badge */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold tracking-wider text-amber-300 uppercase">
            <Stethoscope className="size-3 text-amber-400" />
            Smart Doctor Diagnosis
          </span>
          <span className="font-mono text-[11px] text-fog-500">
            {diagnosis.category}
          </span>
        </div>
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="cursor-pointer font-mono text-[11px] text-fog-400 underline-offset-2 hover:text-fog-200 hover:underline"
        >
          {showRaw ? "Hide technical codes" : "View raw error codes"}
        </button>
      </div>

      {/* Main Headline & Summary */}
      <div className="mt-3">
        <h4 className="flex items-center gap-2 text-[15px] font-bold tracking-tight text-white">
          <AlertTriangle className="size-4 shrink-0 text-amber-400" />
          {diagnosis.headline}
        </h4>
        <p className="mt-1 leading-relaxed text-fog-200">{diagnosis.summary}</p>
      </div>

      {/* Beginner Trap Alert Callout */}
      <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
        <Lightbulb className="size-4 shrink-0 text-amber-300" />
        <div className="text-[12px] leading-relaxed text-amber-200/90">
          <span className="font-semibold text-amber-100">Why this happens: </span>
          {diagnosis.beginnerTrap}
        </div>
      </div>

      {/* Recommended Steps */}
      <div className="mt-3">
        <p className="font-mono text-[11px] font-semibold tracking-wider text-fog-400 uppercase">
          Recommended Action Items
        </p>
        <ul className="mt-1.5 space-y-1.5 text-[12px] text-fog-300">
          {diagnosis.recommendedSteps.map((step, idx) => (
            <li key={idx} className="flex items-start gap-2">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-signal-500/10 font-mono text-[10px] font-bold text-signal-400">
                {idx + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Code Snippet Tabs */}
      {snippets.length > 0 && currentSnippet && (
        <div className="mt-3 overflow-hidden rounded-lg border border-edge bg-ink-950">
          <div className="flex items-center justify-between border-b border-edge px-3 py-1.5">
            <div className="flex items-center gap-1 overflow-x-auto">
              <Code2 className="mr-1 size-3.5 text-fog-500" />
              {snippets.map((snip, idx) => (
                <button
                  key={snip.label}
                  onClick={() => setActiveSnippetIdx(idx)}
                  className={cx(
                    "cursor-pointer rounded px-2 py-0.5 font-mono text-[11px] transition",
                    activeSnippetIdx === idx
                      ? "bg-ink-800 text-signal-300"
                      : "text-fog-500 hover:text-fog-300"
                  )}
                >
                  {snip.label}
                </button>
              ))}
            </div>
            <button
              onClick={handleCopy}
              className="inline-flex cursor-pointer items-center gap-1 font-mono text-[11px] text-fog-400 transition hover:text-white"
              title="Copy snippet"
            >
              {copied ? (
                <>
                  <Check className="size-3 text-signal-400" />
                  <span className="text-signal-400">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="size-3" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>
          <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-fog-200">
            <code>{currentSnippet.code}</code>
          </pre>
        </div>
      )}

      {/* Raw error code toggle view */}
      {showRaw && (
        <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/40 p-3 font-mono text-[11px]">
          <p className="font-semibold text-red-300">
            Error Code: {errorCode ?? "UNKNOWN"}
          </p>
          {errorMessage && (
            <p className="mt-1 break-words text-fog-300">{errorMessage}</p>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-edge/60 pt-3">
        {diagnosis.suggestedAction && onNavigate && (
          <button
            onClick={() => onNavigate(diagnosis.suggestedAction!.targetTab)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-edge bg-ink-800 px-3 py-1.5 font-mono text-[12px] font-semibold text-white transition hover:border-signal-500/50 hover:bg-ink-700"
          >
            {diagnosis.suggestedAction.icon === "settings" ? (
              <Sliders className="size-3.5 text-signal-400" />
            ) : (
              <ScrollText className="size-3.5 text-signal-400" />
            )}
            {diagnosis.suggestedAction.label}
          </button>
        )}
        {onRetry && (
          <button
            onClick={onRetry}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-signal-400 px-3 py-1.5 font-mono text-[12px] font-semibold text-ink-950 transition hover:bg-signal-300"
          >
            <RotateCcw className="size-3.5" />
            Retry Flight
          </button>
        )}
      </div>
    </div>
  );
}
