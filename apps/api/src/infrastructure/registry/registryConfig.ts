const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;

const NAMESPACE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const HOST_PATTERN =
  /^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?$/;

const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const MAX_HOST_LENGTH = 255;
const MAX_NAMESPACE_LENGTH = 255;
const MAX_REPOSITORY_LENGTH = 255;

export interface RegistryConfig {
  registryHost: string;
  namespace: string;
  insecure: boolean;
}

export class RegistryConfigError extends Error {
  readonly code = "INVALID_REGISTRY_CONFIG";

  constructor(message: string) {
    super(message);
    this.name = "RegistryConfigError";
  }
}

function hasControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function validateRegistryHost(host: string): string {
  const value = host.trim();

  if (!value) throw new RegistryConfigError("Registry host must not be empty");

  if (value.length > MAX_HOST_LENGTH) throw new RegistryConfigError("Registry host is too long");

  if (/\s/.test(value) || hasControlCharacters(value)) {
    throw new RegistryConfigError("Registry host must not contain whitespace or control characters");
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    throw new RegistryConfigError("Registry host must not include a URL scheme (use bare hostname[:port])");
  }

  if (value.includes("@") || value.includes("/")) {
    throw new RegistryConfigError("Registry host must not contain credentials or path separators");
  }

  if (!HOST_PATTERN.test(value.toLowerCase())) {
    throw new RegistryConfigError("Registry host must be a hostname with an optional :port");
  }

  const port = value.split(":")[1];

  if (
    port !== undefined &&
    (!/^[0-9]{1,5}$/.test(port) ||
      Number(port) < 1 ||
      Number(port) > 65535)
  ) {
    throw new RegistryConfigError("Registry port must be between 1 and 65535");
  }

  return value.toLowerCase();
}

export function validateRegistryNamespace(namespace: string): string {
  const value = namespace.trim().toLowerCase();

  if (!value) throw new RegistryConfigError("Registry namespace must not be empty");

  if (value.length > MAX_NAMESPACE_LENGTH) throw new RegistryConfigError("Registry namespace is too long");

  if (/\s/.test(namespace) || hasControlCharacters(namespace)) {
    throw new RegistryConfigError("Registry namespace must not contain whitespace or control characters");
  }

  if (namespace !== namespace.toLowerCase()) {
    throw new RegistryConfigError("Registry namespace must be lowercase");
  }

  if (!NAMESPACE_PATTERN.test(value)) {
    throw new RegistryConfigError("Registry namespace must match [a-z0-9]+([._-][a-z0-9]+)*");
  }

  return value;
}

function hostnameWithoutPort(host: string): string {
  return host.split(":")[0].toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const name = hostnameWithoutPort(host);

  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name === "::1" ||
    name === "host.docker.internal"
  );
}

function isLocalComposeRegistry(host: string): boolean {
  return hostnameWithoutPort(host) === "deploykit-registry";
}

function parseInsecureFlag(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }

  const value = raw.trim().toLowerCase();

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  throw new RegistryConfigError("DEPLOYKIT_REGISTRY_INSECURE must be true/false (or 1/0)");
}

function assertInsecureAllowed(
  host: string,
  insecure: boolean
): void {
  if (!insecure) {
    return;
  }

  if (isLoopbackHost(host) || isLocalComposeRegistry(host)) {
    return;
  }

  throw new RegistryConfigError(
    "Insecure registry access is permitted only for local development targets " +
      "(localhost, 127.0.0.1, host.docker.internal, deploykit-registry)"
  );
}

export function getRegistryConfig(): RegistryConfig {
  const rawHost = process.env.DEPLOYKIT_REGISTRY_HOST;
  const rawNamespace = process.env.DEPLOYKIT_REGISTRY_NAMESPACE;
  const rawInsecure = process.env.DEPLOYKIT_REGISTRY_INSECURE;

  if (rawHost === undefined || rawHost.trim() === "") {
    throw new RegistryConfigError("Missing required env var DEPLOYKIT_REGISTRY_HOST");
  }

  if (rawNamespace === undefined || rawNamespace.trim() === "") {
    throw new RegistryConfigError("Missing required env var DEPLOYKIT_REGISTRY_NAMESPACE");
  }

  const registryHost = validateRegistryHost(rawHost);
  const namespace = validateRegistryNamespace(rawNamespace);
  const insecure = parseInsecureFlag(rawInsecure);

  assertInsecureAllowed(registryHost, insecure);

  return { registryHost, namespace, insecure };
}

export function getOptionalRegistryConfig(): RegistryConfig | null {
  const rawHost = process.env.DEPLOYKIT_REGISTRY_HOST;

  if (rawHost === undefined || rawHost.trim() === "") {
    return null;
  }

  return getRegistryConfig();
}

export function isRegistryConfigured(): boolean {
  return getOptionalRegistryConfig() !== null;
}

export function validateRegistryRepository(repository: string): string {
  const value = repository.trim();

  if (!value) throw new RegistryConfigError("Registry repository must not be empty");

  if (value.length > MAX_REPOSITORY_LENGTH) throw new RegistryConfigError("Registry repository is too long");

  if (value !== value.toLowerCase()) {
    throw new RegistryConfigError("Registry repository must use lowercase characters");
  }

  if (/\s/.test(value) || hasControlCharacters(value)) {
    throw new RegistryConfigError("Registry repository must not contain whitespace or control characters");
  }

  if (value.includes("@")) {
    throw new RegistryConfigError("Registry repository must not contain a digest");
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    throw new RegistryConfigError("Registry repository must not include a URL scheme");
  }

  const parts = value.split("/").filter(Boolean);

  if (parts.length < 2) throw new RegistryConfigError("Registry repository must include a registry host prefix");

  if (!HOST_PATTERN.test(parts[0])) {
    throw new RegistryConfigError("Registry repository has an invalid registry host prefix");
  }

  for (const part of parts.slice(1)) {
    if (
      part.length === 0 ||
      part.length > MAX_NAMESPACE_LENGTH ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part)
    ) {
      throw new RegistryConfigError(
        `Invalid registry repository component: ${part}`
      );
    }
  }

  return value;
}

export function validateRegistryTag(tag: string): string {
  const value = tag.trim();

  if (!TAG_PATTERN.test(value)) {
    throw new RegistryConfigError("Invalid image tag");
  }

  return value;
}

export function validateImageDigest(digest: string): string {
  const value = digest.trim();

  if (!DIGEST_PATTERN.test(value)) {
    throw new RegistryConfigError("Image digest must match sha256:<64 hex chars>");
  }

  return value.toLowerCase();
}

export function buildImageReference(
  repository: string,
  tag: string
): string {
  return `${validateRegistryRepository(repository)}:${validateRegistryTag(tag)}`;
}

export function digestReference(
  repository: string,
  digest: string
): string {
  return `${validateRegistryRepository(repository)}@${validateImageDigest(digest)}`;
}

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toLowerCase();
}

export function registryRepositoryForProject(
  config: RegistryConfig,
  projectId: string
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      projectId
    )
  ) {
    throw new RegistryConfigError("Invalid project id");
  }

  return validateRegistryRepository(
    `${config.registryHost}/${config.namespace}/project-${shortId(projectId)}`
  );
}

export function registryTagForDeployment(
  deploymentId: string,
  commitSha: string
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      deploymentId
    )
  ) {
    throw new RegistryConfigError("Invalid deployment id");
  }

  if (!/^[0-9a-f]{40}$/i.test(commitSha.trim())) {
    throw new RegistryConfigError("Registry tag requires a valid 40-char commit SHA");
  }

  return validateRegistryTag(
    `d-${shortId(deploymentId)}-${commitSha.trim().slice(0, 7).toLowerCase()}`
  );
}
