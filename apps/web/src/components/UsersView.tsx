import { useCallback, useEffect, useState } from "react";
import {
  createInvite,
  fetchInvites,
  fetchUsers,
  revokeInvite,
  setUserDisabled,
} from "../lib/api";
import { timeAgo } from "../lib/format";
import type { AdminUser, Invite } from "../types";
import { cx } from "../lib/format";
import { EmptyState, Eyebrow, Panel, PanelHead, QuietBtn } from "./ui";

type Tab = "users" | "invites";

// timeAgo only renders past moments ("just now" for future input), but invite
// expiry is ahead of now, so compute a forward-looking delta instead.
function until(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((t - Date.now()) / 60000);
  if (mins < 1) return "any moment now";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

export function UsersView({ currentUserId }: { currentUserId: string }) {
  const [tab, setTab] = useState<Tab>("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [freshToken, setFreshToken] = useState<{ email: string; token: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, i] = await Promise.all([fetchUsers(), fetchInvites()]);
      setUsers(u);
      setInvites(i);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const toggleDisabled = async (user: AdminUser) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const updated = await setUserDisabled(user.id, user.disabled_at === null);
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setNotice(
        updated.disabled_at
          ? `${updated.email} disabled — their sessions are revoked immediately.`
          : `${updated.email} re-enabled.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update user");
    } finally {
      setBusy(false);
    }
  };

  const submitInvite = async () => {
    const email = inviteEmail.trim();
    if (!email || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { invite, token } = await createInvite(email);
      setInvites((prev) => [invite, ...prev]);
      setInviteEmail("");
      setFreshToken({ email: invite.email, token });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create invite");
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (id: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const invite = await revokeInvite(id);
      setInvites((prev) => prev.map((i) => (i.id === invite.id ? invite : i)));
      setNotice(`Invite for ${invite.email} revoked.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke invite");
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!freshToken) return;
    const url = `${window.location.origin}${window.location.pathname}#invite=${freshToken.token}`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Invite link copied to clipboard.");
    } catch {
      setNotice("Could not copy — select the link manually.");
    }
  };

  const activeAdmins = users.filter((u) => u.role === "admin" && u.disabled_at === null).length;

  return (
    <div className="dk-stagger flex flex-col gap-4">
      <div>
        <Eyebrow>Access control</Eyebrow>
        <h1 className="mt-1 text-xl font-bold tracking-tight text-white">Users & invites</h1>
        <p className="mt-1 text-[13px] text-fog-500">
          {users.length} account{users.length === 1 ? "" : "s"} · {activeAdmins} active admin
          {activeAdmins === 1 ? "" : "s"} · registration is invite-only
        </p>
      </div>

      <div className="flex gap-1 rounded-lg bg-ink-900 p-1" role="tablist" aria-label="User management">
        {(["users", "invites"] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cx(
              "flex-1 cursor-pointer rounded-md px-3 py-1.5 text-[13px] transition",
              tab === t
                ? "bg-ink-700 font-semibold text-white"
                : "text-fog-500 hover:text-fog-100"
            )}
          >
            {t === "users" ? "Accounts" : "Invites"}
          </button>
        ))}
      </div>

      {notice && (
        <p className="rounded-lg border border-signal-500/40 bg-signal-950/40 px-3 py-2 text-[13px] text-signal-200">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-[13px] text-red-200">
          {error}
        </p>
      )}
      {loading && <p className="font-mono text-[13px] text-fog-500">loading…</p>}

      {!loading && tab === "users" && (
        <Panel>
          <PanelHead title="Accounts" />
          {users.length === 0 ? (
            <EmptyState title="No accounts yet" body="The first account to register becomes the admin." />
          ) : (
            <ul className="divide-y divide-edge/70">
              {users.map((u) => {
                const isSelf = u.id === currentUserId;
                const disabled = u.disabled_at !== null;
                return (
                  <li key={u.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <span
                      className={cx(
                        "grid size-8 shrink-0 place-items-center rounded-lg text-[12px] font-bold",
                        disabled ? "bg-ink-800 text-fog-500" : "bg-ink-700 text-fog-200"
                      )}
                    >
                      {u.email.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 leading-tight">
                      <p className={cx("truncate text-[13px]", disabled ? "text-fog-500 line-through" : "text-fog-100")}>
                        {u.email}
                      </p>
                      <p className="font-mono text-[11px] text-fog-500">
                        joined {timeAgo(u.created_at)}
                        {isSelf ? " · you" : ""}
                      </p>
                    </div>
                    <span
                      className={cx(
                        "rounded-full border px-2 py-0.5 font-mono text-[11px]",
                        u.role === "admin"
                          ? "border-signal-500/50 bg-signal-950 text-signal-300"
                          : "border-edge text-fog-500"
                      )}
                    >
                      {u.role}
                    </span>
                    <span
                      className={cx(
                        "rounded-full border px-2 py-0.5 font-mono text-[11px]",
                        disabled ? "border-red-900 bg-red-950/40 text-red-200" : "border-edge text-fog-500"
                      )}
                    >
                      {disabled ? "disabled" : "active"}
                    </span>
                    <span className="ml-auto flex gap-2">
                      <QuietBtn
                        disabled={busy || isSelf}
                        title={
                          isSelf
                            ? "You cannot disable your own account"
                            : disabled
                              ? "Enable account"
                              : "Disable account"
                        }
                        onClick={() => void toggleDisabled(u)}
                      >
                        {disabled ? "Enable" : "Disable"}
                      </QuietBtn>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      )}

      {!loading && tab === "invites" && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHead title="Invite someone" />
            <div className="flex flex-col gap-3 p-4">
              <p className="text-[13px] leading-relaxed text-fog-400">
                Create a single-use invite link. The person you share it with sets their own
                password — you never handle their credentials.
              </p>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitInvite();
                }}
              >
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  aria-label="Invitee email"
                  maxLength={254}
                  className="w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 text-[13px] text-fog-100 outline-none placeholder:text-fog-500 focus:border-signal-500"
                />
                <button
                  type="submit"
                  disabled={busy || !inviteEmail.trim()}
                  className="shrink-0 cursor-pointer rounded-lg bg-signal-400 px-3 py-2 text-[13px] font-semibold text-ink-950 disabled:opacity-50"
                >
                  {busy ? "Working…" : "Invite"}
                </button>
              </form>
              {freshToken && (
                <div className="rounded-lg border border-signal-500/40 bg-signal-950/40 p-3">
                  <Eyebrow>Invite link — shown once</Eyebrow>
                  <p className="mt-1 mb-2 text-[12px] text-fog-400">
                    Send this to {freshToken.email}. It expires in 7 days and works only once.
                  </p>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={`${window.location.origin}${window.location.pathname}#invite=${freshToken.token}`}
                      aria-label="Invite link"
                      onFocus={(e) => e.currentTarget.select()}
                      className="w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 font-mono text-[11px] text-fog-200 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void copyLink()}
                      className="shrink-0 cursor-pointer rounded-lg border border-edge bg-ink-800 px-3 py-2 text-[12px] font-medium text-fog-200 hover:text-white"
                    >
                      Copy
                    </button>
                  </div>
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHead title="Invites" />
            {invites.length === 0 ? (
              <EmptyState title="No invites yet" body="Invitations you create appear here with their status." />
            ) : (
              <ul className="divide-y divide-edge/70">
                {invites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <div className="min-w-0 leading-tight">
                      <p className="truncate text-[13px] text-fog-100">{i.email}</p>
                      <p className="font-mono text-[11px] text-fog-500">
                        {i.status === "pending"
                          ? `expires ${until(i.expires_at)}`
                          : i.status === "accepted"
                            ? `accepted ${timeAgo(i.accepted_at!)}`
                            : i.status === "revoked"
                              ? `revoked ${timeAgo(i.revoked_at!)}`
                              : "expired"}
                      </p>
                    </div>
                    <span
                      className={cx(
                        "ml-auto rounded-full border px-2 py-0.5 font-mono text-[11px]",
                        i.status === "pending"
                          ? "border-signal-500/50 bg-signal-950 text-signal-300"
                          : i.status === "accepted"
                            ? "border-edge text-emerald-300"
                            : "border-edge text-fog-500"
                      )}
                    >
                      {i.status}
                    </span>
                    {i.status === "pending" && (
                      <button
                        onClick={() => void onRevoke(i.id)}
                        disabled={busy}
                        className="cursor-pointer rounded-md border border-red-900 px-2 py-1 text-[12px] text-red-200 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
