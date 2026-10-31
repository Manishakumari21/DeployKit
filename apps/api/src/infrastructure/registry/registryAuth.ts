import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const REGISTRY_USERNAME_ENV = "DEPLOYKIT_REGISTRY_USERNAME";
export const REGISTRY_PASSWORD_ENV = "DEPLOYKIT_REGISTRY_PASSWORD";

export interface RegistryCredentials {
  username: string;
  password: string;
}

export interface RegistryLoginOptions {
  dockerBinary: string;
  registryHost: string;
  credentials: RegistryCredentials;
  /** Directory that will hold config.json (docker login persists here). */
  dockerConfigDir: string;
  /** Directory holding per-host CA bundles (…/<hostname>/ca.crt). */
  certsDir?: string;
  timeoutMs?: number;
}

export interface RegistryLoginResult {
  code: number;
  timedOut: boolean;
  stderr: string;
}

const DEFAULT_LOGIN_TIMEOUT_MS = 30_000;

/** Returns null when either value is absent/blank so auth stays opt-in. */
export function resolveRegistryCredentials(
  env: NodeJS.ProcessEnv = process.env
): RegistryCredentials | null {
  const username = (env[REGISTRY_USERNAME_ENV] ?? "").trim();
  const password = env[REGISTRY_PASSWORD_ENV] ?? "";

  if (username === "" || password === "") {
    return null;
  }

  return { username, password };
}

/** `docker login` argv; the password is piped to stdin, never placed here. */
export function registryLoginArgs(
  registryHost: string,
  username: string
): string[] {
  return ["login", "--username", username, "--password-stdin", registryHost];
}

/** Existing per-host CA bundle (certsDir/<hostname>/ca.crt), or null. */
export function registryLoginCaPath(
  registryHost: string,
  certsDir: string
): string | null {
  const hostname = registryHost.split(":")[0].toLowerCase();
  if (hostname === "") return null;
  const candidate = path.join(certsDir, hostname, "ca.crt");
  return existsSync(candidate) ? candidate : null;
}

/**
 * Runs `docker login`, piping the password to stdin and pointing DOCKER_CONFIG
 * at a controlled dir so credentials persist for later docker/buildx commands.
 * When a CA bundle exists for the host it is set via SSL_CERT_FILE so the
 * handshake trusts the gateway TLS cert without disabling verification.
 */
export function performRegistryLogin(
  options: RegistryLoginOptions
): Promise<RegistryLoginResult> {
  const {
    dockerBinary,
    registryHost,
    credentials,
    dockerConfigDir,
    certsDir,
    timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  } = options;

  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_CONFIG: dockerConfigDir };

  const caPath = certsDir
    ? registryLoginCaPath(registryHost, certsDir)
    : null;
  if (caPath) {
    env.SSL_CERT_FILE = caPath;
  }

  return new Promise((resolve) => {
    const child = spawn(
      dockerBinary,
      registryLoginArgs(registryHost, credentials.username),
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        shell: false,
      }
    );

    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: RegistryLoginResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", () => {});
    child.stderr.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-4096);
    });
    child.on("error", (e) => {
      finish({ code: 1, timedOut, stderr: e.message });
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, timedOut, stderr });
    });

    child.stdin.on("error", () => {});
    child.stdin.write(credentials.password);
    child.stdin.end();
  });
}
