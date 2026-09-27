import { useState } from "react";
import { cx } from "../lib/format";
import { timeAgo } from "../lib/format";
import type { Deployment, DeployStatus } from "../types";
import { Avatar, Panel, StatusPill } from "./ui";

const FILTERS: ("all" | DeployStatus | "production")[] = ["all", "production", "ready", "building", "failed"];

export function DeploysTable({ deployments }: { deployments: Deployment[] }) {
  const [f, setF] = useState<(typeof FILTERS)[number]>("all");
  const rows = deployments.filter((d) =>
    f === "all" ? true : f === "production" ? d.env === "production" : d.status === f
  );
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 px-3 py-2.5">
        {FILTERS.map((x) => (
          <button
            key={x}
            onClick={() => setF(x)}
            className={cx(
              "rounded-full px-2.5 py-1 text-[12px] capitalize transition",
              f === x ? "bg-zinc-100 font-semibold text-zinc-950" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            )}
          >
            {x}
          </button>
        ))}
        <span className="ml-auto font-mono text-[11px] text-zinc-600">{rows.length} deploys</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-160 text-left text-[13px]">
          <thead>
            <tr className="border-b border-zinc-800 text-[11px] tracking-wide text-zinc-500 uppercase">
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Commit</th>
              <th className="px-4 py-2 font-medium">Service</th>
              <th className="px-4 py-2 font-medium">Author</th>
              <th className="px-4 py-2 text-right font-medium">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {rows.map((d) => (
              <tr key={d.id} className="transition hover:bg-zinc-900/70">
                <td className="px-4 py-2.5">
                  <StatusPill status={d.status} />
                </td>
                <td className="max-w-56 px-4 py-2.5">
                  <p className="truncate font-medium text-zinc-100">{d.message}</p>
                  <p className="font-mono text-[11px] text-zinc-500">
                    {d.commit} · {d.branch} · {d.duration}
                  </p>
                </td>
                <td className="px-4 py-2.5 text-zinc-300">{d.projectName}</td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1.5 text-zinc-400">
                    <Avatar name={d.author} /> {d.author}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[11px] text-zinc-500">{timeAgo(d.createdAt)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-zinc-500">
                  No deploys match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
