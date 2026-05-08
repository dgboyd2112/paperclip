import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePaperclipSkillSymlink,
  listPaperclipSkillEntries,
  removeMaintainerOnlySkillSymlinks,
} from "@paperclipai/adapter-utils/server-utils";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("paperclip skill utils", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("lists bundled runtime skills from ./skills without pulling in .agents/skills", async () => {
    const root = await makeTempDir("paperclip-skill-roots-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip"), { recursive: true });
    await fs.mkdir(path.join(root, "skills", "paperclip-create-agent"), { recursive: true });
    await fs.mkdir(path.join(root, ".agents", "skills", "release"), { recursive: true });

    const entries = await listPaperclipSkillEntries(moduleDir);

    expect(entries.map((entry) => entry.key)).toEqual([
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/paperclip-create-agent",
    ]);
    expect(entries.map((entry) => entry.runtimeName)).toEqual([
      "paperclip",
      "paperclip-create-agent",
    ]);
    expect(entries[0]?.source).toBe(path.join(root, "skills", "paperclip"));
    expect(entries[1]?.source).toBe(path.join(root, "skills", "paperclip-create-agent"));
  });

  it("marks skills with required: false in SKILL.md frontmatter as optional", async () => {
    const root = await makeTempDir("paperclip-skill-optional-");
    cleanupDirs.add(root);

    const moduleDir = path.join(root, "a", "b", "c", "d", "e");
    await fs.mkdir(moduleDir, { recursive: true });

    // Required skill (no frontmatter flag)
    const requiredDir = path.join(root, "skills", "paperclip");
    await fs.mkdir(requiredDir, { recursive: true });
    await fs.writeFile(path.join(requiredDir, "SKILL.md"), "---\nname: paperclip\n---\n\n# Paperclip\n");

    // Optional skill (required: false)
    const optionalDir = path.join(root, "skills", "paperclip-dev");
    await fs.mkdir(optionalDir, { recursive: true });
    await fs.writeFile(path.join(optionalDir, "SKILL.md"), "---\nname: paperclip-dev\nrequired: false\n---\n\n# Dev\n");

    const entries = await listPaperclipSkillEntries(moduleDir);
    entries.sort((a, b) => a.runtimeName.localeCompare(b.runtimeName));

    expect(entries).toHaveLength(2);
    expect(entries[0]?.runtimeName).toBe("paperclip");
    expect(entries[0]?.required).toBe(true);
    expect(entries[1]?.runtimeName).toBe("paperclip-dev");
    expect(entries[1]?.required).toBe(false);
    expect(entries[1]?.requiredReason).toBeNull();
  });

  it("removes stale maintainer-only symlinks from a shared skills home", async () => {
    const root = await makeTempDir("paperclip-skill-cleanup-");
    cleanupDirs.add(root);

    const skillsHome = path.join(root, "skills-home");
    const runtimeSkill = path.join(root, "skills", "paperclip");
    const customSkill = path.join(root, "custom", "release-notes");
    const staleMaintainerSkill = path.join(root, ".agents", "skills", "release");

    await fs.mkdir(skillsHome, { recursive: true });
    await fs.mkdir(runtimeSkill, { recursive: true });
    await fs.mkdir(customSkill, { recursive: true });

    const linkType = process.platform === "win32" ? "junction" : undefined;
    await fs.symlink(runtimeSkill, path.join(skillsHome, "paperclip"), linkType);
    await fs.symlink(customSkill, path.join(skillsHome, "release-notes"), linkType);
    await fs.symlink(staleMaintainerSkill, path.join(skillsHome, "release"), linkType);

    const removed = await removeMaintainerOnlySkillSymlinks(skillsHome, ["paperclip"]);

    expect(removed).toEqual(["release"]);
    await expect(fs.lstat(path.join(skillsHome, "release"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "paperclip"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "release-notes"))).isSymbolicLink()).toBe(true);
  });

  describe("ensurePaperclipSkillSymlink", () => {
    it("creates a new link when the target is absent", async () => {
      const root = await makeTempDir("paperclip-ensure-create-");
      cleanupDirs.add(root);
      const source = path.join(root, "skills", "paperclip");
      const target = path.join(root, "home", "paperclip");
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "SKILL.md"), "marker", "utf8");
      await fs.mkdir(path.dirname(target), { recursive: true });

      const result = await ensurePaperclipSkillSymlink(source, target);

      expect(result).toBe("created");
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("marker");
    });

    it("skips when the target already points at the right source", async () => {
      const root = await makeTempDir("paperclip-ensure-skip-");
      cleanupDirs.add(root);
      const source = path.join(root, "skills", "paperclip");
      const target = path.join(root, "home", "paperclip");
      await fs.mkdir(source, { recursive: true });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await ensurePaperclipSkillSymlink(source, target);

      const result = await ensurePaperclipSkillSymlink(source, target);

      expect(result).toBe("skipped");
    });

    it("repairs a dangling symlink to a non-existent source", async () => {
      const root = await makeTempDir("paperclip-ensure-repair-");
      cleanupDirs.add(root);
      const goodSource = path.join(root, "skills", "paperclip");
      const danglingSource = path.join(root, "skills", "old-paperclip");
      const target = path.join(root, "home", "paperclip");
      await fs.mkdir(goodSource, { recursive: true });
      await fs.mkdir(danglingSource, { recursive: true });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(
        danglingSource,
        target,
        process.platform === "win32" ? "junction" : undefined,
      );
      await fs.rm(danglingSource, { recursive: true, force: true });

      const result = await ensurePaperclipSkillSymlink(goodSource, target);

      expect(result).toBe("repaired");
      const linked = await fs.readlink(target);
      const resolved = path.isAbsolute(linked) ? linked : path.resolve(path.dirname(target), linked);
      const normalized = process.platform === "win32" && resolved.startsWith("\\\\?\\")
        ? resolved.slice(4)
        : resolved;
      expect(path.normalize(normalized).toLowerCase()).toBe(
        path.normalize(goodSource).toLowerCase(),
      );
    });

    it("returns skipped when the target is a real directory (not a symlink)", async () => {
      const root = await makeTempDir("paperclip-ensure-realdir-");
      cleanupDirs.add(root);
      const source = path.join(root, "skills", "paperclip");
      const target = path.join(root, "home", "paperclip");
      await fs.mkdir(source, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "stale.txt"), "stale", "utf8");

      const result = await ensurePaperclipSkillSymlink(source, target);

      expect(result).toBe("skipped");
      expect(await fs.readFile(path.join(target, "stale.txt"), "utf8")).toBe("stale");
    });

    it.runIf(process.platform === "win32")(
      "produces a Windows junction whose contents are readable",
      async () => {
        const root = await makeTempDir("paperclip-ensure-win-");
        cleanupDirs.add(root);
        const source = path.join(root, "skills", "paperclip");
        const target = path.join(root, "home", "paperclip");
        await fs.mkdir(source, { recursive: true });
        await fs.writeFile(path.join(source, "SKILL.md"), "windows works", "utf8");
        await fs.mkdir(path.dirname(target), { recursive: true });

        const result = await ensurePaperclipSkillSymlink(source, target);

        expect(result).toBe("created");
        expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("windows works");
      },
    );
  });
});
