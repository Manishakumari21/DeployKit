import { Check, X } from "lucide-react";

export function Toast({ msg, onClose }: { msg: string | null; onClose: () => void }) {
  if (!msg) return null;
  return (
    <div className="fixed bottom-5 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-[13px] text-zinc-100 shadow-2xl">
      <Check size={15} className="shrink-0 text-emerald-400" /> {msg}
      <button onClick={onClose} aria-label="Dismiss" className="text-zinc-500 hover:text-white">
        <X size={14} />
      </button>
    </div>
  );
}
