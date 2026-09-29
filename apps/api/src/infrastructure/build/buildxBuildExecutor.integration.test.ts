
import test from "node:test";
import assert from "node:assert/strict";

import {
  mkdtemp,
  writeFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  execFile,
} from "node:child_process";
import {
  promisify,
} from "node:util";
import {
  randomUUID,
} from "node:crypto";

import {
  BuildxBuildExecutor,
} from "./buildxBuildExecutor.js";

const execFileAsync = promisify(execFile);

test(
  "BuildxBuildExecutor builds an image and returns its digest",
  {
    timeout: 180_000,
  },
  async () => {
    const workspace = await mkdtemp(
      path.join(
        os.tmpdir(),
        "deploykit-build-test-"
      )
    );

    const imageTag =
      `integration-${randomUUID().replaceAll("-", "")}`;

    const imageReference =
      `deploykit/build-test:${imageTag}`;

    try {
      await writeFile(
        path.join(
          workspace,
          "Dockerfile"
        ),
        `FROM alpine:3.22
COPY test.txt /test.txt
RUN test "$(cat /test.txt)" = "DeployKit Buildx integration test"
CMD ["sh"]
`
      );

      await writeFile(
        path.join(
          workspace,
          "test.txt"
        ),
        "DeployKit Buildx integration test\n"
      );

      const executor =
        new BuildxBuildExecutor();

      const result =
        await executor.build({
          workspace,
          imageRepository:
            "deploykit/build-test",
          imageTag,
          commitSha:
            "0123456789abcdef0123456789abcdef01234567",
          policy: {
            timeoutMs: 120_000,
            memoryBytes:
              1024 * 1024 * 1024,
            cpuLimit: 2,
            pidsLimit: 256,
            networkEnabled: true,
            maxBuildContextBytes:
              50 * 1024 * 1024,
          },
        });

      assert.equal(
        result.imageReference,
        imageReference
      );

      assert.match(
        result.imageDigest,
        /^sha256:[0-9a-f]{64}$/i
      );

      const inspect =
        await execFileAsync(
          "docker",
          [
            "image",
            "inspect",
            imageReference,
            "--format",
            "{{.Id}}",
          ],
          {
            maxBuffer: 64 * 1024,
          }
        );

      assert.match(
        inspect.stdout.trim(),
        /^sha256:[0-9a-f]{64}$/i
      );
    } finally {
      await execFileAsync(
        "docker",
        [
          "image",
          "rm",
          "-f",
          imageReference,
        ],
        {
          maxBuffer: 64 * 1024,
        }
      ).catch(() => undefined);

      await rm(
        workspace,
        {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        }
      );
    }
  }
);

