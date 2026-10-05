import { GitBranch, X } from "lucide-react";
import { useState } from "react";
import { DeployBtn, Panel, QuietBtn } from "./ui";

export function ProjectModal({
  open,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (name: string, repo: string, branch: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  if (!open) return null;

  const input =
    "w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 text-[13px] text-fog-100 shadow-[inset_0_1px_0_rgb(194_220_245/0.05)] outline-none placeholder:text-fog-500 focus:border-signal-500";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md animate-rise">
        <Panel className="p-5">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h2 className="text-[16px] font-bold tracking-tight text-white">Commission a service</h2>
              <p className="mt-0.5 flex items-center gap-1 font-mono text-[12px] text-fog-500">
                <GitBranch size={12} className="text-signal-300" /> point at a Git repository
              </p>
            </div>
            <button onClick={onClose} aria-label="Close" className="cursor-pointer rounded-md p-1 text-fog-500 transition hover:text-white">
              <X size={16} />
            </button>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await onSubmit(name, repo, branch)) {
                setName("");
                setRepo("");
                setBranch("main");
              }
            }}
            className="flex flex-col gap-3"
          >
            <label className="flex flex-col gap-1 text-[12px] font-medium text-fog-200">
              Service name
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="marketing-site" maxLength={60} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-fog-200">
              Git URL
              <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/acme/website" inputMode="url" className={`${input} font-mono`} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-fog-200">
              Branch
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className={`${input} font-mono`} />
            </label>
            {error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[12px] text-red-200">{error}</p>}
            <div className="mt-1 flex justify-end gap-1.5">
              <QuietBtn type="button" onClick={onClose} disabled={busy}>Cancel</QuietBtn>
              <DeployBtn type="submit" disabled={busy}>{busy ? "Commissioning…" : "Commission service"}</DeployBtn>
            </div>
          </form>
        </Panel>
      </div>
    </div>
  );
}
