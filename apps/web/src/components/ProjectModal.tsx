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
    "w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md">
        <Panel className="bg-zinc-900 p-5">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h2 className="text-[15px] font-semibold text-white">New service</h2>
              <p className="mt-0.5 flex items-center gap-1 text-[12px] text-zinc-500">
                <GitBranch size={12} /> Import a Git repository
              </p>
            </div>
            <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-zinc-500 hover:text-white">
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
            <label className="flex flex-col gap-1 text-[12px] font-medium text-zinc-300">
              Name
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="marketing-site" maxLength={60} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-zinc-300">
              Git URL
              <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/acme/website" inputMode="url" className={`${input} font-mono`} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] font-medium text-zinc-300">
              Branch
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className={`${input} font-mono`} />
            </label>
            {error && <p className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[12px] text-red-200">{error}</p>}
            <div className="mt-1 flex justify-end gap-1.5">
              <QuietBtn type="button" onClick={onClose} disabled={busy}>Cancel</QuietBtn>
              <DeployBtn type="submit" disabled={busy}>{busy ? "Creating…" : "Create service"}</DeployBtn>
            </div>
          </form>
        </Panel>
      </div>
    </div>
  );
}
