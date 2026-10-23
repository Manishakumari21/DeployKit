import { describe, expect, test } from "vitest";

import {
  configValue,
  draftFromConfig,
  draftToBuildConfig,
  emptyDraft,
  fieldErrorFromMessage,
  isSafeApplicationRoot,
  isSafeRelativePath,
  sourceLabel,
  validateDraft,
} from "./buildConfig";
import type { BuildConfig, DraftBuildConfig } from "./buildConfig";

const validDraft: DraftBuildConfig = {
  applicationRoot: "apps/web",
  builder: "dockerfile",
  dockerfilePath: "Dockerfile",
  buildCommand: "npm run build",
  startCommand: "npm start",
  outputDirectory: "dist",
};

const savedConfig: BuildConfig = {
  applicationRoot: "apps/web",
  builder: "dockerfile",
  dockerfilePath: "Dockerfile",
  buildCommand: "npm run build",
  startCommand: "npm start",
  outputDirectory: "dist",
};

describe("build configuration draft", () => {
  test("valid values pass and convert to the backend schema", () => {
    expect(validateDraft(validDraft)).toEqual({});
    expect(draftToBuildConfig(validDraft)).toEqual(savedConfig);
    expect(draftToBuildConfig(draftFromConfig(savedConfig))).toEqual(savedConfig);
  });

  test("empty optional values become null and an empty root becomes the default", () => {
    expect(draftToBuildConfig({ ...emptyDraft(), builder: "node" })).toEqual({
      applicationRoot: ".",
      builder: "node",
      dockerfilePath: null,
      buildCommand: null,
      startCommand: null,
      outputDirectory: null,
    });
  });

  test("unsafe paths are rejected", () => {
    for (const applicationRoot of [
      "/etc",
      "../outside",
      "apps/../../etc",
      "apps\\web",
      "~/home",
      "apps//web",
      "./apps",
    ]) {
      expect(
        validateDraft({ ...validDraft, applicationRoot }).applicationRoot
      ).toBeTruthy();
    }
    expect(validateDraft({ ...validDraft, applicationRoot: "." }).applicationRoot).toBeUndefined();
  });

  test("Dockerfile path is required only for the Dockerfile builder", () => {
    expect(validateDraft({ ...validDraft, dockerfilePath: "" }).dockerfilePath).toMatch(
      /required/
    );
    expect(
      validateDraft({ ...validDraft, dockerfilePath: "../Dockerfile" }).dockerfilePath
    ).toMatch(/safe relative/);
    expect(validateDraft({ ...validDraft, builder: "node", dockerfilePath: "../nope" })).toEqual(
      {}
    );
  });

  test("command limits and control characters are enforced", () => {
    expect(
      validateDraft({ ...validDraft, buildCommand: "x".repeat(2001) }).buildCommand
    ).toMatch(/2000/);
    expect(
      validateDraft({ ...validDraft, startCommand: "npm start\u0001" }).startCommand
    ).toMatch(/Control characters/);
  });

  test("an invalid builder cannot be converted", () => {
    expect(validateDraft({ ...validDraft, builder: "ruby" }).builder).toBe("Select a builder.");
    expect(() => draftToBuildConfig({ ...emptyDraft(), builder: "ruby" })).toThrow(
      "Builder is required"
    );
  });

  test("backend field errors are mapped back to the form field", () => {
    expect(
      fieldErrorFromMessage("dockerfilePath: required for the dockerfile builder")
    ).toEqual({ field: "dockerfilePath", message: "required for the dockerfile builder" });
    expect(fieldErrorFromMessage("Failed to process request")).toEqual({
      message: "Failed to process request",
    });
    expect(fieldErrorFromMessage("unknownField: nope")).toEqual({
      message: "unknownField: nope",
    });
  });

  test("path and display helpers reflect backend rules", () => {
    expect(isSafeRelativePath("apps/web")).toBe(true);
    expect(isSafeRelativePath(".")).toBe(false);
    expect(isSafeRelativePath("apps/./web")).toBe(false);
    expect(isSafeApplicationRoot(".")).toBe(true);
    expect(configValue(null)).toBe("not set");
    expect(configValue("dist")).toBe("dist");
    expect(sourceLabel("explicit")).toBe("saved");
    expect(sourceLabel("detected")).toBe("detected");
    expect(sourceLabel("default")).toBe("default");
  });
});
