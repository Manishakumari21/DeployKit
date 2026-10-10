import { useState } from "react";
import type { FormEvent } from "react";
import { DeployBtn, Eyebrow, Panel } from "./ui";

type Mode = "login" | "register";

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 72;

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
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFormError("Enter a valid email address.");
      return;
    }

    if (password.length === 0) {
      setFormError("Enter your password.");
      return;
    }
    if (mode === "register") {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setFormError(`Choose a password with at least ${MIN_PASSWORD_LENGTH} characters (${password.length}/${MIN_PASSWORD_LENGTH}).`);
        return;
      }
      if (password.length > MAX_PASSWORD_LENGTH) {
        setFormError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password.trim().length === 0) {
        setFormError("Password cannot be blank spaces only.");
        return;
      }
      await onRegister(email.trim(), password);
      return;
    }
    await onLogin(email.trim(), password);
  };

  const input =
    "w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 pr-16 text-[13px] text-fog-100 outline-none placeholder:text-fog-500 focus:border-signal-500";
  const met = password.length >= MIN_PASSWORD_LENGTH;
  const visibleError = formError ?? error;

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
                setShowPassword(false);
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
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
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
              required
              className="w-full rounded-lg border border-edge bg-ink-950 px-3 py-2 text-[13px] text-fog-100 outline-none placeholder:text-fog-500 focus:border-signal-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-[13px] text-fog-200">
            <span className="flex items-baseline justify-between">
              Password
              {mode === "register" && (
                <span className={`text-[11px] tabular-nums ${met ? "text-emerald-300" : "text-fog-500"}`}>
                  {password.length}/{MIN_PASSWORD_LENGTH} min
                </span>
              )}
            </span>
            <span className="relative block">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "login" ? "Your password" : "Use at least 12 characters"}
                aria-label="Password"
                aria-describedby={mode === "register" ? "password-hint" : undefined}
                minLength={mode === "register" ? MIN_PASSWORD_LENGTH : undefined}
                maxLength={MAX_PASSWORD_LENGTH}
                required
                className={input}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded-md px-2 py-1 text-[11px] font-semibold text-fog-400 hover:bg-ink-800 hover:text-fog-100"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </span>
          </label>
          {mode === "register" && (
            <p id="password-hint" className={`text-[12px] ${met ? "text-emerald-300" : "text-fog-500"}`}>
              {met ? "Good length — 12+ characters." : "Password must be 12–72 characters."}
            </p>
          )}
          {visibleError && (
            <p role="alert" className="text-[13px] text-red-300">
              {visibleError}
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
