import test from "node:test";
import assert from "node:assert/strict";

import {
  parseDfUsage,
  diskPressureLevel,
  readDiskThresholds,
  measureRegistryDiskUsage,
  DEFAULT_DISK_THRESHOLDS,
} from "./registryDiskGuard.js";

const BUSYBOX_DF = `Filesystem           1K-blocks      Used Available Use% Mounted on
/dev/nvme0n1p2       495911220 153955172 340560460  31% /etc/hostname
`;

const GNU_DF = `Filesystem     1K-blocks     Used Available Use% Mounted on
overlay         495911220 430000000  65911220  87% /var/lib/registry
`;

test("parseDfUsage reads the used percent and available space from a df row", () => {
  assert.deepEqual(parseDfUsage(BUSYBOX_DF), {
    usedPercent: 31,
    availableKB: 340560460,
  });
});

test("parseDfUsage handles GNU df output with a single data row", () => {
  assert.deepEqual(parseDfUsage(GNU_DF), {
    usedPercent: 87,
    availableKB: 65911220,
  });
});

test("parseDfUsage tolerates filesystem names that contain digits and spaces", () => {
  const tricky = `Filesystem 1K-blocks Used Available Use% Mounted on
shm 64124 0 64124 0% /dev/shm
overlay 102623488 94333956 3077812 97% /var/lib/registry
`;
  assert.deepEqual(parseDfUsage(tricky), {
    usedPercent: 97,
    availableKB: 3077812,
  });
});

test("parseDfUsage returns null when there is no usable data row", () => {
  assert.equal(parseDfUsage(""), null);
  assert.equal(parseDfUsage("Filesystem 1K-blocks Used Available Use% Mounted on\n"), null);
  assert.equal(parseDfUsage("some non df text"), null);
});

test("diskPressureLevel classifies usage against the thresholds", () => {
  const t = { softPercent: 85, hardPercent: 95 };
  assert.equal(diskPressureLevel(10, t), "ok");
  assert.equal(diskPressureLevel(84.9, t), "ok");
  assert.equal(diskPressureLevel(85, t), "soft", "soft threshold is inclusive");
  assert.equal(diskPressureLevel(90, t), "soft");
  assert.equal(diskPressureLevel(95, t), "hard", "hard threshold is inclusive");
  assert.equal(diskPressureLevel(99.9, t), "hard");
});

test("readDiskThresholds defaults and clamps env input", () => {
  assert.deepEqual(readDiskThresholds({}), DEFAULT_DISK_THRESHOLDS);
  assert.deepEqual(readDiskThresholds({ DEPLOYKIT_REGISTRY_DISK_SOFT_PERCENT: "80" }), {
    softPercent: 80,
    hardPercent: 95,
  });
  assert.deepEqual(
    readDiskThresholds({
      DEPLOYKIT_REGISTRY_DISK_SOFT_PERCENT: "99",
      DEPLOYKIT_REGISTRY_DISK_HARD_PERCENT: "90",
    }),
    { softPercent: 99, hardPercent: 99 },
    "hard is never allowed below soft"
  );
  assert.deepEqual(
    readDiskThresholds({ DEPLOYKIT_REGISTRY_DISK_SOFT_PERCENT: "abc" }),
    DEFAULT_DISK_THRESHOLDS,
    "non-numeric input falls back to the default"
  );
  assert.deepEqual(
    readDiskThresholds({ DEPLOYKIT_REGISTRY_DISK_HARD_PERCENT: "150" }),
    { softPercent: 85, hardPercent: 100 },
    "percentages are clamped to 100"
  );
});

test("measureRegistryDiskUsage is a safe no-op when the binary is unreachable", async () => {
  const usage = await measureRegistryDiskUsage({
    dockerBinary: "definitely-not-a-docker-binary-xyz",
    registryContainer: "nope",
  });
  assert.equal(usage, null);
});
