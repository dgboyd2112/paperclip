import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformLink } from "./server-utils.js";

const isWindows = process.platform === "win32";

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("createPlatformLink", () => {
  const cleanup = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      Array.from(cleanup).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    cleanup.clear();
    vi.restoreAllMocks();
  });

  it("links a directory source to a target", async () => {
    const root = await mkTmp("paperclip-link-dir-");
    cleanup.add(root);
    const source = path.join(root, "src");
    const target = path.join(root, "tgt");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "marker.txt"), "hello", "utf8");

    const kind = await createPlatformLink(source, target, { type: "dir" });

    expect(kind).toBe(isWindows ? "junction" : "symlink");
    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(target, "marker.txt"), "utf8")).toBe("hello");
  });

  it("links a file source to a target", async () => {
    const root = await mkTmp("paperclip-link-file-");
    cleanup.add(root);
    const source = path.join(root, "src.txt");
    const target = path.join(root, "tgt.txt");
    await fs.writeFile(source, "hello", "utf8");

    // On Windows, file-type symlinks require Developer Mode. Allow either the
    // direct symlink success path or the copy-fallback path so this test
    // works in any Windows configuration. POSIX always succeeds as a symlink.
    let kind: "symlink" | "junction" | "copy";
    try {
      kind = await createPlatformLink(source, target, { type: "file", copyFallback: true });
    } catch (err) {
      // If copyFallback is false and Dev Mode is off on Windows, EPERM bubbles.
      if (isWindows) return;
      throw err;
    }

    if (isWindows) {
      expect(["symlink", "copy"]).toContain(kind);
    } else {
      expect(kind).toBe("symlink");
    }
    expect(await fs.readFile(target, "utf8")).toBe("hello");
  });

  it('"auto" type stats the source to pick dir vs file', async () => {
    const root = await mkTmp("paperclip-link-auto-");
    cleanup.add(root);
    const sourceDir = path.join(root, "srcdir");
    const sourceFile = path.join(root, "src.txt");
    const targetDir = path.join(root, "tgtdir");
    const targetFile = path.join(root, "tgt.txt");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(sourceFile, "x", "utf8");

    const dirKind = await createPlatformLink(sourceDir, targetDir, {
      type: "auto",
      copyFallback: true,
    });
    expect(dirKind).toBe(isWindows ? "junction" : "symlink");

    let fileKind: "symlink" | "junction" | "copy";
    try {
      fileKind = await createPlatformLink(sourceFile, targetFile, {
        type: "auto",
        copyFallback: true,
      });
    } catch (err) {
      if (isWindows) return;
      throw err;
    }
    if (isWindows) {
      expect(["symlink", "copy"]).toContain(fileKind);
    } else {
      expect(fileKind).toBe("symlink");
    }
  });

  it.runIf(isWindows)("falls back to copy on EPERM when copyFallback is true", async () => {
    const root = await mkTmp("paperclip-link-fallback-");
    cleanup.add(root);
    const source = path.join(root, "src");
    const target = path.join(root, "tgt");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "data.txt"), "payload", "utf8");

    const eperm = Object.assign(new Error("EPERM: operation not permitted"), {
      code: "EPERM",
    });
    const symlinkSpy = vi.spyOn(fs, "symlink").mockRejectedValueOnce(eperm);
    const onFallback = vi.fn();

    const kind = await createPlatformLink(source, target, {
      type: "dir",
      copyFallback: true,
      onFallback,
    });

    expect(kind).toBe("copy");
    expect(symlinkSpy).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith("copy");
    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(target, "data.txt"), "utf8")).toBe("payload");
  });

  it.runIf(isWindows)("falls back to copy on EXDEV when copyFallback is true", async () => {
    const root = await mkTmp("paperclip-link-exdev-");
    cleanup.add(root);
    const source = path.join(root, "src");
    const target = path.join(root, "tgt");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "data.txt"), "payload", "utf8");

    const exdev = Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" });
    vi.spyOn(fs, "symlink").mockRejectedValueOnce(exdev);

    const kind = await createPlatformLink(source, target, {
      type: "dir",
      copyFallback: true,
    });

    expect(kind).toBe("copy");
    expect(await fs.readFile(path.join(target, "data.txt"), "utf8")).toBe("payload");
  });

  it.runIf(isWindows)("rethrows EPERM when copyFallback is false", async () => {
    const root = await mkTmp("paperclip-link-rethrow-");
    cleanup.add(root);
    const source = path.join(root, "src");
    const target = path.join(root, "tgt");
    await fs.mkdir(source, { recursive: true });

    const eperm = Object.assign(new Error("EPERM: operation not permitted"), {
      code: "EPERM",
    });
    vi.spyOn(fs, "symlink").mockRejectedValueOnce(eperm);

    await expect(
      createPlatformLink(source, target, { type: "dir", copyFallback: false }),
    ).rejects.toThrow(/EPERM/);
  });
});
