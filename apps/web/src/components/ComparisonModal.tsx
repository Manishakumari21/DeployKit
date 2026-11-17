import { Check, DollarSign, HeartPulse, Server, ShieldCheck, X } from "lucide-react";

export function ComparisonModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  const comparisonData = [
    {
      feature: "Hosting Cost",
      deploykit: "$0 PaaS Markup (flat VPS rate $5–$20/mo)",
      vercel: "Usage tiers + $20/seat/mo + bandwidth",
      render: "Tiered compute + egress fees",
      railway: "Usage execution + compute markup",
      highlight: true,
    },
    {
      feature: "Smart Error Doctor",
      deploykit: "Built-in (Plain English root cause + 1-click code fixes)",
      vercel: "Generic error codes (FUNCTION_INVOCATION_FAILED)",
      render: "Raw terminal logs only",
      railway: "Raw container logs only",
      highlight: true,
    },
    {
      feature: "Data & Secrets Sovereignty",
      deploykit: "100% on your server (AES-256-GCM encrypted)",
      vercel: "Proprietary cloud storage",
      render: "Cloud infrastructure",
      railway: "Cloud infrastructure",
      highlight: true,
    },
    {
      feature: "Team Members",
      deploykit: "Unlimited free with Role-Based Access Control",
      vercel: "$20/member/month on Pro tier",
      render: "Paid organization seats",
      railway: "Team seat add-on fees",
      highlight: false,
    },
    {
      feature: "Distributed Edge Nodes",
      deploykit: "Included out-of-the-box (attach any bare metal VPS)",
      vercel: "Enterprise plan only",
      render: "Single cloud region",
      railway: "Cloud regions only",
      highlight: false,
    },
    {
      feature: "Multi-Stack Auto-Detection",
      deploykit: "Static, Vite/React, Node.js, Python, Rust, Go, Dockerfile",
      vercel: "Frontend & Serverless-focused",
      render: "Docker & standard buildpacks",
      railway: "Nixpacks & Dockerfile",
      highlight: false,
    },
    {
      feature: "Zero-Downtime Releases",
      deploykit: "Atomic OpenResty gateway reload + health verification",
      vercel: "Automated routing switch",
      render: "Automated container cutover",
      railway: "Automated container cutover",
      highlight: false,
    },
    {
      feature: "Database & Backups",
      deploykit: "Self-hosted PostgreSQL + non-blocking verified pg_dump",
      vercel: "Add-on cloud integrations",
      render: "Managed Postgres add-on ($7+/mo)",
      railway: "Managed Postgres add-on",
      highlight: false,
    },
  ];

  const pillars = [
    {
      icon: DollarSign,
      title: "$0 PaaS Markup",
      desc: "Stop paying $50–$200/mo for basic developer hosting. Run unlimited apps on a $5–$10/mo Hetzner or DigitalOcean VPS.",
    },
    {
      icon: HeartPulse,
      title: "Smart Error Doctor",
      desc: "No more spending hours debugging container crashes. DeployKit automatically diagnoses port traps, OOM errors, and missing start scripts.",
    },
    {
      icon: ShieldCheck,
      title: "Zero-Trust Privacy",
      desc: "Your source code, customer databases, and environment secrets remain completely private on your own isolated infrastructure.",
    },
    {
      icon: Server,
      title: "Edge Node Swarms",
      desc: "Have spare hardware or secondary servers? Enroll them in seconds with a single lightweight agent command.",
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink-950/85 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl max-h-[90vh] overflow-y-auto animate-rise rounded-2xl border border-edge bg-ink-900 shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-edge bg-ink-950/95 px-6 py-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-signal-400 font-mono text-base font-bold text-ink-950 shadow-[0_4px_16px_-4px_rgb(62_207_142/0.8)]">
              ⚡
            </span>
            <div>
              <h2 className="text-[17px] font-bold text-white tracking-tight">
                Why DeployKit? — Platform Comparison
              </h2>
              <p className="font-mono text-[11px] text-fog-500">
                The push-to-deploy developer experience of Vercel & Render on your own hardware
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close comparison"
            className="cursor-pointer rounded-lg p-1.5 text-fog-400 transition hover:bg-ink-800 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 flex flex-col gap-6">
          {/* 4 Pillars Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {pillars.map((p, idx) => (
              <div
                key={idx}
                className="flex flex-col gap-1.5 rounded-xl border border-edge bg-ink-950/60 p-4 transition hover:border-signal-500/30"
              >
                <div className="flex items-center gap-2 text-signal-300 font-semibold text-[13px]">
                  <p.icon size={16} />
                  <span>{p.title}</span>
                </div>
                <p className="text-[11px] leading-relaxed text-fog-400">
                  {p.desc}
                </p>
              </div>
            ))}
          </div>

          {/* Detailed Feature Comparison Table */}
          <div className="overflow-x-auto rounded-xl border border-edge bg-ink-950/70">
            <table className="w-full text-left border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-edge bg-ink-900/90 text-fog-400 font-mono text-[11px]">
                  <th className="py-3 px-4 font-semibold text-fog-300">Feature</th>
                  <th className="py-3 px-4 font-bold text-signal-300 bg-signal-950/30 border-x border-signal-500/20">
                    DeployKit (Self-Hosted)
                  </th>
                  <th className="py-3 px-4">Vercel</th>
                  <th className="py-3 px-4">Render</th>
                  <th className="py-3 px-4">Railway</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge/60">
                {comparisonData.map((row, index) => (
                  <tr
                    key={index}
                    className="transition hover:bg-ink-800/40"
                  >
                    <td className="py-3 px-4 font-medium text-fog-200 whitespace-nowrap">
                      {row.feature}
                    </td>
                    <td className="py-3 px-4 font-semibold text-signal-200 bg-signal-950/20 border-x border-signal-500/10">
                      <div className="flex items-start gap-1.5">
                        <Check size={14} className="mt-0.5 text-signal-400 shrink-0" />
                        <span>{row.deploykit}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-fog-400 leading-snug">
                      {row.vercel}
                    </td>
                    <td className="py-3 px-4 text-fog-400 leading-snug">
                      {row.render}
                    </td>
                    <td className="py-3 px-4 text-fog-400 leading-snug">
                      {row.railway}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Quickstart Callout */}
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-signal-500/30 bg-signal-950/30 p-4">
            <div>
              <p className="text-[13px] font-bold text-signal-200">
                Ready to deploy your first project?
              </p>
              <p className="mt-0.5 text-[11px] text-fog-400">
                Paste any Git repository or connect GitHub. DeployKit takes care of build, SSL, and routing.
              </p>
            </div>
            <button
              onClick={onClose}
              className="cursor-pointer rounded-lg bg-signal-400 px-4 py-2 text-[12px] font-bold text-ink-950 shadow-md transition hover:bg-signal-300 active:scale-95"
            >
              Continue to Dashboard →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
