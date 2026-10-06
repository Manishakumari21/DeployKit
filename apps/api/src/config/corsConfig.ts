// Centralized CORS policy. Browser auth uses cookies, so a wildcard origin
// is never acceptable: origins are explicit and credentials are reflected
// only for allowlisted origins. Same single source also feeds CSRF checks.

const DEV_DEFAULT_ORIGINS = ["http://localhost:5173", "http://localhost:8081"];

export function getAllowedOrigins(): string[] {
  const raw = process.env.DEPLOYKIT_WEB_ORIGIN;
  if (raw === undefined || raw.trim() === "") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DEPLOYKIT_WEB_ORIGIN must be set explicitly in production");
    }
    return [...DEV_DEFAULT_ORIGINS];
  }
  const origins = raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s.length > 0);
  if (origins.length === 0) {
    throw new Error("DEPLOYKIT_WEB_ORIGIN must list at least one origin");
  }
  for (const origin of origins) {
    if (origin === "*") {
      throw new Error("DEPLOYKIT_WEB_ORIGIN must not be a wildcard when cookies carry credentials");
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`DEPLOYKIT_WEB_ORIGIN contains an invalid origin: ${origin}`);
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(
        `DEPLOYKIT_WEB_ORIGIN must list bare origins (scheme + host + port): ${origin}`
      );
    }
  }
  return [...new Set(origins)];
}

export interface CorsOptions {
  origin: (
    requestOrigin: string | undefined,
    cb: (err: Error | null, allow?: boolean) => void
  ) => void;
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
}

export function buildCorsOptions(): CorsOptions {
  const allowed = new Set(getAllowedOrigins());
  return {
    // Non-browser clients send no Origin and pass through untouched (no
    // ACAO header is added for them). Browsers get a reflected origin only
    // when allowlisted — never a wildcard alongside credentials.
    origin: (requestOrigin, cb) => {
      if (!requestOrigin) {
        cb(null, true);
        return;
      }
      cb(null, allowed.has(requestOrigin));
    },
    credentials: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Idempotency-Key"],
  };
}
