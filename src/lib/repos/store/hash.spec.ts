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
   * hashDirectory should follow a symlink and hash the file it points at, so a
   * linked file counts as content at its own relative path.
   */
  it("should follow a symlink and hash it as a file", async () => {
    const dir = tmp();
    write(dir, "a.md", "alpha");
    fs.symlinkSync(path.join(dir, "a.md"), path.join(dir, "link.md"));

    const plain = tmp();
    write(plain, "a.md", "alpha");
    write(plain, "link.md", "alpha");

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
