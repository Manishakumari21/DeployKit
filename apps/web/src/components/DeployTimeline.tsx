import { GitCommitHorizontal, Plus } from "lucide-react";
import { timeAgo } from "../lib/format";
import type { Deployment } from "../types";
import { Avatar, Panel, PanelHead, StatusPill } from "./ui";

export function DeployTimeline({
  deployments,
  onNew,
}: {
  deployments: Deployment[];
  onNew: () => void;
}) {
  return (
    <Panel>
      <PanelHead
        title="Deployments"
        right={
          <button onClick={onNew} className="inline-flex items-center gap-1 text-[12px] font-medium text-zinc-400 hover:text-white">
            <Plus size={13} /> New
          </button>
        }
      />
      {deployments.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-zinc-500">Push a commit to trigger your first build.</p>
      ) : (
        <ol className="relative ml-4 border-l border-zinc-800">
          {deployments.slice(0, 8).map((d) => (
            <li key={d.id} className="relative flex gap-3 py-3 pr-4 pl-5">
              <span className="absolute top-4 -left-[5px] size-2.5 rounded-full border-2 border-zinc-950 bg-zinc-600" />
              <Avatar name={d.author} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="truncate font-medium text-zinc-100">{d.message}</span>
                  <StatusPill status={d.status} />
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-zinc-500">
                  <span className="inline-flex items-center gap-1">
                    <GitCommitHorizontal size={11} /> {d.commit}
                  </span>
                  <span>{d.branch}</span>
                  <span>{d.env}</span>
                  <span>{d.duration}</span>
                  <span>
                    {timeAgo(d.createdAt)} by {d.author}
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-600">{d.projectName}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
