import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __gitArgvForTest,
  __gitEnvironmentForTest,
  validateRepositoryUrl,
  withCheckedOutRepository,
} from "./sourceCheckout.js";

const TOKEN = "ghs_audit-proof-token-abc123";

test("argv carries no secret for any git operation", () => {
  for (const kind of ["clone", "fetch", "rev-parse"] as const) {
    const argv = __gitArgvForTest(kind).join(" ");
    assert.ok(!argv.includes(TOKEN), `argv must not contain the token (${kind})`);
    assert.ok(!argv.includes("extraHeader"), `argv must not carry credentials (${kind})`);
  }
});

test("credential travels via child env only, prompts stay disabled", () => {
  const env = __gitEnvironmentForTest(TOKEN);
  assert.equal(env.GIT_CONFIG_KEY_0, "http.extraHeader");
  assert.ok(String(env.GIT_CONFIG_VALUE_0).includes(TOKEN));
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_ASKPASS, "/bin/false");
  const bare = __gitEnvironmentForTest(null);
  assert.equal(bare.GIT_CONFIG_COUNT, undefined);
  assert.equal(bare.GIT_CONFIG_VALUE_0, undefined);
});

test("checkout never puts the token in argv, URL, logs, or .git/config", async () => {
  const dir = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), "deploykit-gitproof-"))
  );
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const argvLog = path.join(dir, "argv.log");
  const envLog = path.join(dir, "env.log");
  await writeFile(argvLog, "");
  await writeFile(envLog, "");
  const sha = "f".repeat(40);
  await writeFile(
    path.join(bin, "git"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${argvLog}"
if [ -n "$GIT_CONFIG_VALUE_0" ]; then printf 'present\\n' >> "${envLog}"; else printf 'absent\\n' >> "${envLog}"; fi
has_clone=0; has_rev=0
for a in "$@"; do
  [ "$a" = "clone" ] && has_clone=1
  [ "$a" = "rev-parse" ] && has_rev=1
done
if [ "$has_clone" = "1" ]; then
  for last in "$@"; do :; done
  mkdir -p "$last/.git"
  printf '[core]\\n\\trepositoryformatversion = 0\\n' > "$last/.git/config"
  exit 0
fi
if [ "$has_rev" = "1" ]; then
  echo "${sha}"
  exit 0
fi
exit 0
`
  );
  await chmod(path.join(bin, "git"), 0o755);

  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  process.env.FAKE_GIT_ARGV_LOG = argvLog;
  try {
    const url = "https://github.com/acme/app.git";
    validateRepositoryUrl(url);
    const result = await withCheckedOutRepository(
      { repositoryUrl: url, branch: "main", authToken: TOKEN },
      async ({ workspace, commitSha }) => {
        assert.equal(commitSha, sha);
        const config = await readFile(path.join(workspace, ".git", "config"), "utf8").catch(
          () => ""
        );
        assert.ok(!config.includes(TOKEN), ".git/config must not contain the token");
        assert.ok(!url.includes(TOKEN), "repository URL must not contain the token");
        return { workspace, commitSha };
      }
    );
    assert.equal(result.commitSha, sha);
    const argv = await readFile(argvLog, "utf8");
    assert.ok(argv.length > 0, "fake git must have been invoked");
    assert.ok(!argv.includes(TOKEN), "git argv must not contain the token");
    assert.ok(!argv.includes("bearer"), "git argv must not contain credentials");
    const envLines = (await readFile(envLog, "utf8")).trim().split("\n");
    assert.ok(envLines.length > 0);
    for (const line of envLines) assert.equal(line, "present");
  } finally {
    process.env.PATH = previousPath;
    delete process.env.FAKE_GIT_ARGV_LOG;
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  }
});
