import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("checks out a real GitHub repository and cleans workspace", async () => {
  const checkoutRoot = await mkdtemp(
    path.join(os.tmpdir(), "deploykit-git-test-")
  );

  process.env.DEPLOYKIT_CHECKOUT_ROOT = checkoutRoot;
  process.env.DEPLOYKIT_ALLOWED_GIT_HOSTS = "github.com";

  const { withCheckedOutRepository } = await import(
    "./sourceCheckout.js"
  );

  const result = await withCheckedOutRepository(
    {
      repositoryUrl:
        "https://github.com/Manishakumari21/DeployKit.git",
      branch: "main",
    },
    async (checkout) => {
      assert.ok(checkout.workspace);

      assert.match(
        checkout.commitSha,
        /^[0-9a-f]{40}$/i
      );

      const files = await readdir(checkout.workspace);

      assert.ok(
        files.length > 0,
        "Checked-out repository should contain files"
      );

      return checkout.commitSha;
    }
  );

  assert.match(
    result,
    /^[0-9a-f]{40}$/i
  );

  const remaining = await readdir(checkoutRoot);

  assert.equal(
    remaining.length,
    0,
    "Checkout workspace was not cleaned up"
  );
});

test("cleans workspace when downstream execution fails", async () => {
  const checkoutRoot = await mkdtemp(
    path.join(os.tmpdir(), "deploykit-git-failure-test-")
  );

  process.env.DEPLOYKIT_CHECKOUT_ROOT = checkoutRoot;
  process.env.DEPLOYKIT_ALLOWED_GIT_HOSTS = "github.com";

  const { withCheckedOutRepository } = await import(
    "./sourceCheckout.js"
  );

  await assert.rejects(
    withCheckedOutRepository(
      {
        repositoryUrl:
          "https://github.com/Manishakumari21/DeployKit.git",
        branch: "main",
      },
      async () => {
        throw new Error("simulated downstream failure");
      }
    ),
    {
      message: "simulated downstream failure",
    }
  );

  const remaining = await readdir(checkoutRoot);

  assert.equal(
    remaining.length,
    0,
    "Checkout workspace must be removed after failure"
  );
});
