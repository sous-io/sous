import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { hashDirectory, hashesEqual } from "./hash.js";

const tmpDirs: TmpDir[] = [];

/** Creates a temp dir that is cleaned up after the test. */
function tmp(): string {
  const dir = makeTmpDir("sous-hash-");
  tmpDirs.push(dir);
  return dir.path;
}

/** Writes a file inside `root`, creating parent directories as needed. */
function write(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

afterEach(() => {
  while (tmpDirs.length > 0) tmpDirs.pop()!.cleanup();
});

describe("hashDirectory()", () => {
  /**
   * hashDirectory should return the canonical `sha256-<hex>` shape that
   * contentHashSchema validates.
   *
   * await hashDirectory(dirWithOneFile);
   * // -> "sha256-9f86d0...0f00a08"
   */
  it("should return sha256- followed by 64 lowercase hex characters", async () => {
    const dir = tmp();
    write(dir, "SKILL.md", "hello");

    const hash = await hashDirectory(dir);
    expect(hash).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  /**
   * hashDirectory should be order-independent: two trees holding the same files
   * with the same contents hash equal no matter which order the files were
   * created in.
   */
  it("should hash identical trees created in different orders equally", async () => {
    const first = tmp();
    write(first, "a.md", "alpha");
    write(first, "nested/b.md", "beta");
    write(first, "nested/deep/c.md", "gamma");

    const second = tmp();
    write(second, "nested/deep/c.md", "gamma");
    write(second, "nested/b.md", "beta");
    write(second, "a.md", "alpha");

    expect(await hashDirectory(first)).toBe(await hashDirectory(second));
  });

  /**
   * hashDirectory should change when a single byte of a file changes.
   */
  it("should change when a file's contents change by one byte", async () => {
    const dir = tmp();
    write(dir, "a.md", "alpha");
    const before = await hashDirectory(dir);

    write(dir, "a.md", "alphb");
    expect(await hashDirectory(dir)).not.toBe(before);
  });

  /**
   * hashDirectory should change when a file is renamed, because the relative
   * path is part of the hashed stream.
   */
  it("should change when a file is renamed", async () => {
    const dir = tmp();
    write(dir, "a.md", "alpha");
    const before = await hashDirectory(dir);

    fs.renameSync(path.join(dir, "a.md"), path.join(dir, "b.md"));
    expect(await hashDirectory(dir)).not.toBe(before);
  });

  /**
   * hashDirectory should change when a file moves to another directory, even
   * with its name and contents unchanged.
   */
  it("should change when a file moves to a different directory", async () => {
    const dir = tmp();
    write(dir, "a.md", "alpha");
    const before = await hashDirectory(dir);

    fs.mkdirSync(path.join(dir, "nested"));
    fs.renameSync(path.join(dir, "a.md"), path.join(dir, "nested", "a.md"));
    expect(await hashDirectory(dir)).not.toBe(before);
  });

  /**
   * hashDirectory should distinguish trees whose concatenated bytes are the
   * same but whose file boundaries differ, because each record carries an
   * explicit byte length.
   */
  it("should distinguish differently split files with the same total bytes", async () => {
    const first = tmp();
    write(first, "a.md", "onetwo");
    write(first, "b.md", "");

    const second = tmp();
    write(second, "a.md", "one");
    write(second, "b.md", "two");

    expect(await hashDirectory(first)).not.toBe(await hashDirectory(second));
  });

  /**
   * hashDirectory should ignore the store's own `.sous.entry.json` marker, so
   * writing the marker (or touching its last-access time) never invalidates the
   * entry it describes.
   */
  it("should ignore the store entry marker", async () => {
    const dir = tmp();
    write(dir, "a.md", "alpha");
    const before = await hashDirectory(dir);

    write(dir, ".sous.entry.json", '{"formatVersion":1}');
    expect(await hashDirectory(dir)).toBe(before);
  });

  /**
   * hashDirectory should ignore `.git`, so a hashed working copy matches the
   * same files fetched without history.
   */
  it("should ignore a .git directory", async () => {
    const dir = tmp();
    write(dir, "a.md", "alpha");
    const before = await hashDirectory(dir);

    write(dir, ".git/HEAD", "ref: refs/heads/main\n");
    write(dir, ".git/objects/ab/cdef", "binary-ish");
    expect(await hashDirectory(dir)).toBe(before);
  });

  /**
   * hashDirectory should ignore empty directories, which carry no content a
   * recipe can use and do not survive every transport.
   */
  it("should ignore empty directories", async () => {
    const dir = tmp();
    write(dir, "a.md", "alpha");
    const before = await hashDirectory(dir);

    fs.mkdirSync(path.join(dir, "empty", "deeper"), { recursive: true });
    expect(await hashDirectory(dir)).toBe(before);
  });

  /**
   * A hash has to mean the same thing on the publisher's machine and the
   * consumer's. A symlink points at bytes the repository does not own, so
   * following it made the hash depend on whatever happened to be at the target;
   * the same published version then hashed differently on two machines and
   * failed its own pin on every install. Links contribute nothing at all.
   *
   * // a tree with a link, and the same tree without it
   * hashDirectory(withLink) === hashDirectory(withoutLink);  // -> true
   */
  it("should hash a tree containing a symlink the same as one without it", async () => {
    const dir = tmp();
    write(dir, "a.md", "alpha");
    fs.symlinkSync(path.join(dir, "a.md"), path.join(dir, "link.md"));

    const plain = tmp();
    write(plain, "a.md", "alpha");

    expect(await hashDirectory(dir)).toBe(await hashDirectory(plain));
  });

  /**
   * The whole point of skipping links is that the target's presence cannot
   * change the answer, so a tree hashes the same on a machine where the target
   * is missing as on one where it is there.
   *
   * // link -> /usr/share/doc/x, present on one machine and not the other
   * hashDirectory(present) === hashDirectory(dangling);  // -> true
   */
  it("should hash a tree containing a symlink the same on a machine where the target is missing", async () => {
    const target = tmp();
    write(target, "outside.md", "bytes this repository does not own");

    const present = tmp();
    write(present, "a.md", "alpha");
    fs.symlinkSync(path.join(target, "outside.md"), path.join(present, "link.md"));

    const dangling = tmp();
    write(dangling, "a.md", "alpha");
    fs.symlinkSync(path.join(dangling, "nothing-is-here.md"), path.join(dangling, "link.md"));

    expect(await hashDirectory(present)).toBe(await hashDirectory(dangling));
  });

  /**
   * A linked DIRECTORY is skipped whole, so nothing under it is walked either.
   *
   * // linkedDir -> a directory full of files outside the recipe
   * hashDirectory(withLinkedDir) === hashDirectory(withoutIt);  // -> true
   */
  it("should not walk into a linked directory", async () => {
    const outside = tmp();
    write(outside, "deep/other.md", "not ours");

    const dir = tmp();
    write(dir, "a.md", "alpha");
    fs.symlinkSync(outside, path.join(dir, "linked"));

    const plain = tmp();
    write(plain, "a.md", "alpha");

    expect(await hashDirectory(dir)).toBe(await hashDirectory(plain));
  });

  /**
   * hashDirectory should return a stable hash for an empty directory: the hash
   * of an empty stream.
   */
  it("should hash an empty directory without failing", async () => {
    expect(await hashDirectory(tmp())).toBe(await hashDirectory(tmp()));
  });
});

describe("hashesEqual()", () => {
  /**
   * hashesEqual should be true only for identical canonical hashes.
   *
   * hashesEqual("sha256-aa", "sha256-aa"); // -> true
   * hashesEqual("sha256-aa", "sha256-bb"); // -> false
   */
  it("should compare two content hashes exactly", () => {
    expect(hashesEqual("sha256-aa", "sha256-aa")).toBe(true);
    expect(hashesEqual("sha256-aa", "sha256-bb")).toBe(false);
  });
});
