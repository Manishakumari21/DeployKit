import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Globe,
  Hammer,
  Lock,
  Plus,
  Rocket,
  ScrollText,
} from "lucide-react";
import type { NavKey, Project } from "../types";
import { Panel, PanelHead } from "./ui";

export function OnboardingChecklist({
  projects,
  deploymentCount,
  onNewProject,
  onNavigate,
}: {
  projects: Project[];
  deploymentCount: number;
  onNewProject: () => void;
  onNavigate: (tab: NavKey) => void;
}) {
  const hasProject = projects.length > 0;
  const hasDeployment = deploymentCount > 0;

  const steps = [
    {
      id: "project",
      title: "1. Commission your first service",
      desc: "Connect any Git repository (GitHub, GitLab, or raw Git URL).",
      completed: hasProject,
      action: () => onNewProject(),
      actionLabel: hasProject ? "Commission another" : "Commission service",
      icon: Plus,
    },
    {
      id: "build",
      title: "2. Inspect build configuration",
      desc: "DeployKit auto-detects Node.js, Python, Rust, Go, or custom Dockerfile.",
      completed: hasProject,
      action: () => onNavigate("build"),
      actionLabel: "Inspect build",
      icon: Hammer,
    },
    {
      id: "env",
      title: "3. Configure encrypted environment variables",
      desc: "Secrets are encrypted with AES-256-GCM and never leaked in logs.",
      completed: hasProject,
      action: () => onNavigate("settings"),
      actionLabel: "Configure secrets",
      icon: Lock,
    },
    {
      id: "deploy",
      title: "4. Dispatch deployment flight",
      desc: "Isolated BuildKit build, immutable OCI digest pinning, zero-downtime switch.",
      completed: hasDeployment,
      action: () => onNavigate("overview"),
      actionLabel: hasDeployment ? "View flights" : "Deploy service",
      icon: Rocket,
    },
    {
      id: "logs",
      title: "5. Stream real-time flight logs",
      desc: "Inspect Git checkout, build output, container startup, and health probes.",
      completed: hasDeployment,
      action: () => onNavigate("logs"),
      actionLabel: "Flight logs",
      icon: ScrollText,
    },
    {
      id: "domain",
      title: "6. Attach custom domain & edge servers",
      desc: "Configure DNS records, automated TLS certificates, and distributed nodes.",
      completed: false,
      action: () => onNavigate("domains"),
      actionLabel: "Custom domains",
      icon: Globe,
    },
  ];

  const completedCount = steps.filter((s) => s.completed).length;
  const percentage = Math.round((completedCount / steps.length) * 100);

  return (
    <Panel className="p-5 overflow-hidden">
      <PanelHead
        title="Quick Start Onboarding"
        right={
          <span className="font-mono text-[11px] text-signal-400">
            {completedCount} of {steps.length} completed ({percentage}%)
          </span>
        }
      />

      <div className="mt-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-950">
          <div
            className="h-full bg-signal-400 transition-all duration-500 ease-out"
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {steps.map((step) => {
          const Icon = step.icon;
          return (
            <div
              key={step.id}
              className={`flex flex-col justify-between rounded-xl border p-4 transition duration-200 ${
                step.completed
                  ? "border-edge bg-ink-900/40"
                  : "border-edge/80 bg-ink-900/90 shadow-sm"
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon size={15} className={step.completed ? "text-signal-400" : "text-fog-400"} />
                    <span
                      className={`text-[13px] font-semibold ${
                        step.completed ? "text-fog-200 line-through decoration-edge" : "text-white"
                      }`}
                    >
                      {step.title}
                    </span>
                  </div>
                  {step.completed ? (
                    <CheckCircle2 size={16} className="text-signal-400 shrink-0" />
                  ) : (
                    <Circle size={16} className="text-fog-500 shrink-0" />
                  )}
                </div>
                <p className="mt-2 text-[12px] text-fog-400 leading-relaxed">
                  {step.desc}
                </p>
              </div>

              <div className="mt-3 pt-2 border-t border-edge/50">
                <button
                  onClick={step.action}
                  className={`inline-flex cursor-pointer items-center gap-1 font-mono text-[11px] transition ${
                    step.completed
                      ? "text-fog-400 hover:text-white"
                      : "text-signal-300 font-semibold hover:text-signal-200"
                  }`}
                >
                  <span>{step.actionLabel}</span>
                  <ArrowRight size={11} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
