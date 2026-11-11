import {
  ArrowRight,
  Boxes,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  Globe,
  Hammer,
  HardDrive,
  Lock,
  RotateCcw,
  Server,
  ShieldCheck,
  Terminal,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { Eyebrow } from "./ui";

export function LandingPage({
  onGetStarted,
  onSignIn,
}: {
  onGetStarted: () => void;
  onSignIn: () => void;
}) {
  const [copiedInstall, setCopiedInstall] = useState(false);
  const installCmd = "curl -fsSL https://raw.githubusercontent.com/Manishakumari21/DeployKit/main/ops/install.sh | bash";

  const copyInstall = async () => {
    try {
      await navigator.clipboard.writeText(installCmd);
      setCopiedInstall(true);
      setTimeout(() => setCopiedInstall(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex flex-col min-h-screen text-fog-100">
      {/* Top Navigation */}
      <header className="sticky top-0 z-40 border-b border-edge bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-signal-400 font-mono text-base font-bold text-ink-950 shadow-[0_8px_24px_-10px_rgb(62_207_142/0.8)]">
              ▚
            </span>
            <span className="font-bold tracking-tight text-white text-[17px]">
              DeployKit
            </span>
            <span className="rounded-full border border-signal-500/30 bg-signal-950/50 px-2 py-0.5 font-mono text-[10px] font-semibold text-signal-300">
              Self-Hosted PaaS
            </span>
          </div>

          <nav className="hidden md:flex items-center gap-6 text-[13px] font-medium text-fog-400">
            <a href="#how-it-works" className="transition hover:text-white">How It Works</a>
            <a href="#features" className="transition hover:text-white">Features</a>
            <a href="#comparison" className="transition hover:text-white">Comparison</a>
            <a href="#stacks" className="transition hover:text-white">Stacks</a>
            <a href="#security" className="transition hover:text-white">Security</a>
            <a href="#install" className="transition hover:text-white">Install</a>
          </nav>

          <div className="flex items-center gap-3">
            <button
              onClick={onSignIn}
              className="cursor-pointer rounded-lg px-3 py-1.5 text-[13px] font-medium text-fog-300 transition hover:text-white"
            >
              Sign In
            </button>
            <button
              onClick={onGetStarted}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-signal-400 px-3.5 py-1.5 text-[13px] font-semibold text-ink-950 shadow-[0_8px_20px_-8px_rgb(62_207_142/0.7)] transition hover:bg-signal-300 active:scale-[0.98]"
            >
              Get Started
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden pt-16 pb-20 sm:pt-24 sm:pb-28">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-[500px] w-[800px] rounded-full opacity-20 blur-[120px]"
          style={{ background: "radial-gradient(circle, rgb(62 207 142) 0%, transparent 70%)" }}
        />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-edge bg-ink-900/80 px-3.5 py-1 text-[12px] text-fog-300 shadow-sm backdrop-blur">
            <span className="size-2 rounded-full bg-signal-400 animate-pulse" />
            <span>Open-source alternative to Vercel, Render & Railway</span>
          </div>

          <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-white sm:text-6xl sm:leading-[1.1]">
            Your infrastructure.<br />
            Your deployments.<br />
            <span className="text-signal-400">Your control.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-[16px] leading-relaxed text-fog-400 sm:text-[18px]">
            DeployKit gives you the push-to-deploy developer experience of modern PaaS platforms on your own hardware or VPS. Standard Docker runtimes, immutable OCI releases, transparent hardware costs, and zero vendor lock-in.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={onGetStarted}
              className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-signal-400 px-5 py-3 text-[14px] font-semibold text-ink-950 shadow-[0_10px_28px_-8px_rgb(62_207_142/0.8)] transition duration-200 hover:bg-signal-300 active:scale-[0.98]"
            >
              Commission Control Plane
              <ArrowRight size={16} />
            </button>
            <a
              href="https://github.com/Manishakumari21/DeployKit"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-edge bg-ink-900 px-5 py-3 text-[14px] font-medium text-white transition hover:border-fog-500 active:scale-[0.98]"
            >
              <GitBranch size={16} />
              GitHub Repository
              <ExternalLink size={13} className="text-fog-500" />
            </a>
          </div>

          {/* 1-Line Install Snippet */}
          <div className="mx-auto mt-8 max-w-xl">
            <div className="flex items-center justify-between rounded-xl border border-edge bg-ink-950/90 px-4 py-2.5 font-mono text-[12px] shadow-lg">
              <span className="text-fog-500 mr-2">$</span>
              <span className="truncate text-fog-200 text-left flex-1 font-mono">{installCmd}</span>
              <button
                onClick={copyInstall}
                aria-label="Copy install command"
                className="ml-3 shrink-0 cursor-pointer rounded-md border border-edge/80 bg-ink-900 px-2.5 py-1 text-[11px] font-medium text-fog-300 hover:text-white"
              >
                {copiedInstall ? (
                  <span className="flex items-center gap-1 text-signal-400">
                    <Check size={12} /> Copied
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <Copy size={12} /> Copy
                  </span>
                )}
              </button>
            </div>
            <p className="mt-2 text-[11px] font-mono text-fog-500">
              Supports clean Ubuntu 22.04+, Debian 12+, and any Linux VPS with Docker 24+
            </p>
          </div>
        </div>
      </section>

      {/* Interactive System Pipeline Demonstration */}
      <section className="relative mx-auto w-full max-w-6xl px-4 sm:px-6 py-10">
        <div className="rounded-2xl border border-edge bg-ink-900/70 p-6 sm:p-8 backdrop-blur shadow-2xl">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge/60 pb-4">
            <div className="flex items-center gap-2">
              <span className="size-2.5 rounded-full bg-signal-400 animate-pulse" />
              <span className="font-mono text-[12px] font-semibold text-white uppercase tracking-wider">
                Production Flight Rail — Live Pipeline
              </span>
            </div>
            <span className="font-mono text-[11px] text-fog-500">
              Zero-Downtime Blue/Green Swapping
            </span>
          </div>

          <div className="mt-6 grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="rounded-xl border border-edge bg-ink-950 p-4">
              <div className="flex items-center gap-2 text-signal-400 text-[13px] font-semibold">
                <GitBranch size={16} />
                <span>1. Push Ingestion</span>
              </div>
              <p className="mt-2 text-[12px] text-fog-400">
                GitHub push or webhook received. Timing-safe HMAC-SHA256 signature verified and delivery deduplicated.
              </p>
              <div className="mt-3 font-mono text-[11px] text-fog-500">
                Event: push · sha256:7b9c...
              </div>
            </div>

            <div className="rounded-xl border border-edge bg-ink-950 p-4">
              <div className="flex items-center gap-2 text-signal-400 text-[13px] font-semibold">
                <Hammer size={16} />
                <span>2. BuildKit & Digests</span>
              </div>
              <p className="mt-2 text-[12px] text-fog-400">
                Smart Dockerfile synthesis or custom Dockerfile built via isolated BuildKit daemon. OCI digest pinned cryptographically.
              </p>
              <div className="mt-3 font-mono text-[11px] text-fog-500">
                Digest: sha256:8f2a...
              </div>
            </div>

            <div className="rounded-xl border border-edge bg-ink-950 p-4">
              <div className="flex items-center gap-2 text-signal-400 text-[13px] font-semibold">
                <ShieldCheck size={16} />
                <span>3. Health Verification</span>
              </div>
              <p className="mt-2 text-[12px] text-fog-400">
                Spins up candidate runtime on isolated <code className="text-signal-300">deploykit-runtime</code> network. Health probe polled until green.
              </p>
              <div className="mt-3 font-mono text-[11px] text-fog-500">
                Probe: HTTP 200 OK (passed)
              </div>
            </div>

            <div className="rounded-xl border border-edge bg-ink-950 p-4">
              <div className="flex items-center gap-2 text-signal-400 text-[13px] font-semibold">
                <Zap size={16} />
                <span>4. Atomic Reload</span>
              </div>
              <p className="mt-2 text-[12px] text-fog-400">
                OpenResty gateway route atomically rewritten and reloaded. Traffic shifts with zero downtime. Old release retired cleanly.
              </p>
              <div className="mt-3 font-mono text-[11px] text-fog-500">
                Route: dk-p88fa0.deploykit.local
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Why Self-Hosted / Core Advantages */}
      <section id="features" className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-16">
        <div className="text-center">
          <Eyebrow>Core Architecture</Eyebrow>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Engineered for Independence & Reliability
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-[15px] text-fog-400">
            DeployKit bridges the gap between complex enterprise orchestration and overpriced managed clouds.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-2xl border border-edge bg-ink-900/60 p-6">
            <div className="grid size-10 place-items-center rounded-xl bg-signal-400/10 text-signal-400">
              <Server size={20} />
            </div>
            <h3 className="mt-4 text-lg font-bold text-white">Self-Hosted Infrastructure</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-fog-400">
              Run on your own $5-40/mo VPS (Hetzner, DigitalOcean, Linode, AWS EC2, or bare metal). You own the host, storage, and database. No metered surprise bills.
            </p>
          </div>

          <div className="rounded-2xl border border-edge bg-ink-900/60 p-6">
            <div className="grid size-10 place-items-center rounded-xl bg-signal-400/10 text-signal-400">
              <Boxes size={20} />
            </div>
            <h3 className="mt-4 text-lg font-bold text-white">No Platform Vendor Lock-In</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-fog-400">
              Applications run as standard OCI Docker containers on standard Linux bridges. No proprietary serverless adaptors, custom runtimes, or captive deployment files.
            </p>
          </div>

          <div className="rounded-2xl border border-edge bg-ink-900/60 p-6">
            <div className="grid size-10 place-items-center rounded-xl bg-signal-400/10 text-signal-400">
              <RotateCcw size={20} />
            </div>
            <h3 className="mt-4 text-lg font-bold text-white">Instant Immutable Rollbacks</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-fog-400">
              Rollbacks never re-clone Git or rebuild code. DeployKit points traffic directly back to previously validated cryptographic OCI digests in sub-second intervals.
            </p>
          </div>

          <div className="rounded-2xl border border-edge bg-ink-900/60 p-6">
            <div className="grid size-10 place-items-center rounded-xl bg-signal-400/10 text-signal-400">
              <Lock size={20} />
            </div>
            <h3 className="mt-4 text-lg font-bold text-white">AES-256-GCM Secret Security</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-fog-400">
              Project environment variables are encrypted at rest with authenticated encryption (AES-256-GCM) derived from your master token pepper. Kept out of frontend payloads.
            </p>
          </div>

          <div className="rounded-2xl border border-edge bg-ink-900/60 p-6">
            <div className="grid size-10 place-items-center rounded-xl bg-signal-400/10 text-signal-400">
              <Globe size={20} />
            </div>
            <h3 className="mt-4 text-lg font-bold text-white">Custom Domains & Auto-TLS</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-fog-400">
              Attach custom domains with automated Let's Encrypt certificate issuance and DNS ownership verification. OpenResty terminates TLS and proxies traffic seamlessly.
            </p>
          </div>

          <div className="rounded-2xl border border-edge bg-ink-900/60 p-6">
            <div className="grid size-10 place-items-center rounded-xl bg-signal-400/10 text-signal-400">
              <HardDrive size={20} />
            </div>
            <h3 className="mt-4 text-lg font-bold text-white">Remote Edge Nodes</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-fog-400">
              Manage multiple servers from a single dashboard. Run the lightweight DeployKit edge daemon on remote nodes to distribute workloads across regions.
            </p>
          </div>
        </div>
      </section>

      {/* Factual Comparison Table */}
      <section id="comparison" className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-16">
        <div className="text-center">
          <Eyebrow>Factual Analysis</Eyebrow>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            DeployKit vs. Managed Hosting Platforms
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-[15px] text-fog-400">
            A verified comparison of deployment models, ownership, pricing predictability, and operational trade-offs.
          </p>
        </div>

        <div className="mt-10 overflow-x-auto rounded-2xl border border-edge bg-ink-900/80 shadow-2xl">
          <table className="w-full text-left border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-edge bg-ink-950/80 text-[12px] font-semibold text-fog-400 uppercase tracking-wider">
                <th className="p-4 sm:p-5">Capability / Dimension</th>
                <th className="p-4 sm:p-5 text-signal-300">DeployKit (Self-Hosted)</th>
                <th className="p-4 sm:p-5">Vercel</th>
                <th className="p-4 sm:p-5">Render</th>
                <th className="p-4 sm:p-5">Railway</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge/60 text-fog-300">
              <tr>
                <td className="p-4 sm:p-5 font-semibold text-white">Hosting Infrastructure</td>
                <td className="p-4 sm:p-5 text-signal-300 font-medium">Your VPS / Bare Metal</td>
                <td className="p-4 sm:p-5 text-fog-400">AWS / Managed Cloud</td>
                <td className="p-4 sm:p-5 text-fog-400">AWS / GCP Managed</td>
                <td className="p-4 sm:p-5 text-fog-400">AWS / GCP Managed</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-semibold text-white">Cost & Pricing Model</td>
                <td className="p-4 sm:p-5 text-signal-300 font-medium">Fixed VPS fee ($5–$40/mo flat)</td>
                <td className="p-4 sm:p-5 text-fog-400">Per-seat + metered bandwidth</td>
                <td className="p-4 sm:p-5 text-fog-400">Per-service RAM/vCPU tiers</td>
                <td className="p-4 sm:p-5 text-fog-400">Per-minute execution meter</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-semibold text-white">Vendor Lock-In</td>
                <td className="p-4 sm:p-5 text-signal-300 font-medium">Zero (Standard OCI Docker)</td>
                <td className="p-4 sm:p-5 text-fog-400">High (Edge/Serverless APIs)</td>
                <td className="p-4 sm:p-5 text-fog-400">Low (Docker supported)</td>
                <td className="p-4 sm:p-5 text-fog-400">Low (Docker supported)</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-semibold text-white">Operational Responsibility</td>
                <td className="p-4 sm:p-5 text-amber-300 font-medium">User maintains host VPS</td>
                <td className="p-4 sm:p-5 text-fog-400">Platform handles host ops</td>
                <td className="p-4 sm:p-5 text-fog-400">Platform handles host ops</td>
                <td className="p-4 sm:p-5 text-fog-400">Platform handles host ops</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-semibold text-white">Rollback Mechanism</td>
                <td className="p-4 sm:p-5 text-signal-300 font-medium">Instant OCI digest reactivate</td>
                <td className="p-4 sm:p-5 text-fog-400">Deployment pointer shift</td>
                <td className="p-4 sm:p-5 text-fog-400">Deployment re-trigger</td>
                <td className="p-4 sm:p-5 text-fog-400">Container snapshot reload</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-semibold text-white">Data Privacy & Sovereignty</td>
                <td className="p-4 sm:p-5 text-signal-300 font-medium">100% on your own hardware</td>
                <td className="p-4 sm:p-5 text-fog-400">Shared US/Global Cloud</td>
                <td className="p-4 sm:p-5 text-fog-400">Multi-tenant Cloud</td>
                <td className="p-4 sm:p-5 text-fog-400">Multi-tenant Cloud</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-semibold text-white">Secret Encryption</td>
                <td className="p-4 sm:p-5 text-signal-300 font-medium">AES-256-GCM authenticated</td>
                <td className="p-4 sm:p-5 text-fog-400">Encrypted at rest (AWS KMS)</td>
                <td className="p-4 sm:p-5 text-fog-400">Encrypted at rest</td>
                <td className="p-4 sm:p-5 text-fog-400">Encrypted at rest</td>
              </tr>
              <tr>
                <td className="p-4 sm:p-5 font-semibold text-white">Remote Edge Nodes</td>
                <td className="p-4 sm:p-5 text-signal-300 font-medium">Built-in daemon support</td>
                <td className="p-4 sm:p-5 text-fog-400">Managed edge network only</td>
                <td className="p-4 sm:p-5 text-fog-400">Not supported (Render only)</td>
                <td className="p-4 sm:p-5 text-fog-400">Not supported (Railway only)</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-center text-[12px] text-fog-500">
          * Note: With DeployKit you manage your host operating system and backups. In return, you keep total ownership and save on managed markup.
        </p>
      </section>

      {/* Supported Stacks */}
      <section id="stacks" className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-12">
        <div className="text-center">
          <Eyebrow>Deployment Capabilities</Eyebrow>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-white">
            Support for Modern Languages & Stacks
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-[14px] text-fog-400">
            DeployKit automatically inspects project manifests and synthesizes optimized, non-root, multi-stage Dockerfiles.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { name: "Node.js", desc: "Next.js, Vite, Express, Remix", tag: "Smart Dockerfile" },
            { name: "Python", desc: "FastAPI, Flask, Django, Poetry", tag: "Smart Dockerfile" },
            { name: "Rust", desc: "Cargo, Actix, Axum", tag: "Multi-stage Cargo" },
            { name: "Go", desc: "Go modules, Gin, Fiber", tag: "Alpine scratch" },
            { name: "Static SPAs", desc: "React, Vue, Svelte, HTML/CSS", tag: "Nginx bundle" },
            { name: "Custom Docker", desc: "Any Dockerfile or Compose", tag: "Full Control" },
          ].map((stack) => (
            <div key={stack.name} className="rounded-xl border border-edge bg-ink-900/60 p-4 text-center">
              <span className="font-bold text-white text-[14px]">{stack.name}</span>
              <p className="mt-1 text-[11px] text-fog-400">{stack.desc}</p>
              <span className="mt-2 inline-block rounded border border-edge bg-ink-950 px-2 py-0.5 font-mono text-[9px] text-signal-400">
                {stack.tag}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Security Principles */}
      <section id="security" className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-12">
        <div className="rounded-2xl border border-edge bg-gradient-to-b from-ink-900/90 to-ink-950 p-8 sm:p-10">
          <div className="flex items-center gap-2 text-signal-400">
            <ShieldCheck size={20} />
            <Eyebrow className="text-signal-400">Defense in Depth</Eyebrow>
          </div>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Hardened Security Architecture
          </h2>
          <p className="mt-2 max-w-2xl text-[14px] text-fog-400">
            Self-hosted does not mean cutting corners on security. DeployKit enforces strict isolation at every layer:
          </p>

          <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="flex flex-col gap-1.5">
              <span className="font-semibold text-white text-[14px]">Container Sandboxing</span>
              <p className="text-[12px] text-fog-400">
                Runtimes run with <code className="text-signal-300">--read-only</code> root filesystems, dropped capabilities (<code className="text-signal-300">--cap-drop ALL</code>), <code className="text-signal-300">no-new-privileges</code>, and strict memory/PID constraints.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-semibold text-white text-[14px]">Secret Masking</span>
              <p className="text-[12px] text-fog-400">
                Environment secrets are never logged in build streams, never passed on raw host command lines, and never returned in bulk API responses without explicit authorized reveal actions.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-semibold text-white text-[14px]">Lease-Fenced Queue</span>
              <p className="text-[12px] text-fog-400">
                PostgreSQL advisory locks and cryptographic lease tokens prevent race conditions and guarantee that stale workers cannot execute or overwrite deployments.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Installation Instructions */}
      <section id="install" className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-16 text-center">
        <Eyebrow>Ready in 2 Minutes</Eyebrow>
        <h2 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Install on Any Linux Server
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-[14px] text-fog-400">
          Run our non-destructive installer script on a clean Linux VPS. It checks prerequisites, generates secure secrets, starts the PostgreSQL database, and brings up the full control plane.
        </p>

        <div className="mx-auto mt-6 max-w-2xl text-left">
          <div className="rounded-2xl border border-edge bg-ink-950 p-5 font-mono text-[12px] shadow-2xl">
            <div className="flex items-center gap-2 border-b border-edge/60 pb-3 text-fog-500">
              <Terminal size={14} />
              <span>terminal — install DeployKit</span>
            </div>
            <div className="mt-3 space-y-2 text-fog-300">
              <p><span className="text-fog-500"># 1. Clone repository</span></p>
              <p className="text-white">git clone https://github.com/Manishakumari21/DeployKit.git && cd DeployKit</p>
              <p className="pt-2"><span className="text-fog-500"># 2. Run automated production installer</span></p>
              <p className="text-signal-300">./ops/install.sh</p>
              <p className="pt-2"><span className="text-fog-500"># 3. Open dashboard at http://&lt;your-ip&gt;:8081</span></p>
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={onGetStarted}
            className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-signal-400 px-6 py-3 text-[14px] font-semibold text-ink-950 shadow-[0_10px_28px_-8px_rgb(62_207_142/0.8)] transition duration-200 hover:bg-signal-300 active:scale-[0.98]"
          >
            Launch DeployKit Now
            <ArrowRight size={16} />
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-edge bg-ink-950/80 py-8">
        <div className="mx-auto flex flex-wrap items-center justify-between gap-4 max-w-6xl px-4 sm:px-6 font-mono text-[11px] text-fog-500">
          <div className="flex items-center gap-2">
            <span className="font-bold text-white">DeployKit</span>
            <span>·</span>
            <span>Self-Hosted Platform-as-a-Service</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="https://github.com/Manishakumari21/DeployKit" target="_blank" rel="noopener noreferrer" className="hover:text-white">
              GitHub
            </a>
            <a href="https://github.com/Manishakumari21/DeployKit/tree/main/docs" target="_blank" rel="noopener noreferrer" className="hover:text-white">
              Documentation
            </a>
            <button onClick={onSignIn} className="cursor-pointer hover:text-white">
              Dashboard Login
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
