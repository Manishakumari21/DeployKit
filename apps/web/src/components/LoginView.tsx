import { useState } from "react";
import type { FormEvent } from "react";
import { DeployBtn, Eyebrow, Panel } from "./ui";

type Mode = "login" | "register";

// Session gate: email + password, nothing else. Credentials travel only in
// the POST body; the session token comes back as an HttpOnly cookie and is
// never readable here. No password is ever logged or displayed.
export function LoginView({
  busy,
  error,
  onLogin,
  onRegister,
}: {
  busy: boolean;
  error: string | null;
  onLogin: (email: string, password: string) => Promise<boolean>;
  onRegister: (email: string, password: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFormError("Enter a valid email address.");
      return;
    }
    if (password.length < 12) {
      setFormError("Password must be at least 12 characters.");
      return;
    }
    if (mode === "login") await onLogin(email.trim(), password);
    else await onRegister(email.trim(), password);
  };

  const input =
    "w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 text-[13px] text-fog-100 outline-none placeholder:text-fog-500 focus:border-signal-500";

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-lg bg-signal-400 font-mono text-base font-bold text-ink-950">
          ▚
        </span>
        <div className="leading-tight">
          <p className="text-[15px] font-bold tracking-tight text-white">deploykit</p>
          <Eyebrow>self-hosted deploys</Eyebrow>
        </div>
      </div>
      <Panel className="p-5">
        <div className="mb-4 flex gap-1 rounded-lg bg-ink-900 p-1" role="tablist" aria-label="Authentication mode">
          {(["login", "register"] as Mode[]).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => {
                setMode(m);
                setFormError(null);
              }}
              className={
                mode === m
                  ? "flex-1 cursor-pointer rounded-md bg-ink-700 px-3 py-1.5 text-[13px] font-semibold text-white"
                  : "flex-1 cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-fog-500 hover:text-fog-100"
              }
            >
              {m === "login" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[13px] text-fog-200">
            Email
            <input
              type="email"
              autoComplete={mode === "login" ? "username" : "email"}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Email"
              maxLength={254}
              className={input}
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-fog-200">
            Password
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "login" ? "Your password" : "At least 12 characters"}
              aria-label="Password"
              maxLength={72}
              className={input}
            />
          </label>
          {(formError || error) && (
            <p role="alert" className="text-[13px] text-red-300">
              {formError ?? error}
            </p>
          )}
          <DeployBtn type="submit" disabled={busy}>
            {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account & sign in"}
          </DeployBtn>
          {mode === "register" && (
            <p className="text-[12px] leading-relaxed text-fog-500">
              The first account on a fresh server can always register; afterwards an operator must
              enable public registration.
            </p>
          )}
        </form>
      </Panel>
    </div>
  );
}
