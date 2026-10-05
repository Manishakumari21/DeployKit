import { Check, X } from "lucide-react";

export function Toast({ msg, onClose }: { msg: string | null; onClose: () => void }) {
  if (!msg) return null;
  return (
    <div role="status" className="fixed bottom-5 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 animate-rise items-center gap-2 rounded-xl border border-signal-500/40 bg-ink-900 px-3.5 py-2.5 text-[13px] text-fog-100 shadow-[0_16px_48px_-12px_rgb(0_0_0/0.8)]">
      <Check size={15} className="shrink-0 text-signal-300" /> {msg}
      <button onClick={onClose} aria-label="Dismiss" className="cursor-pointer text-fog-500 transition hover:text-white">
        <X size={14} />
      </button>
    </div>
  );
}
