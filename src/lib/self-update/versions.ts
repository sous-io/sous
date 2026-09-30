/**
 * Which version of sous an update moves an install to.
 *
 * Everything here is pure: it reads the registry's answer (the abbreviated
 * package document) and the version an install holds, and decides. Nothing is
 * fetched or installed, so a dry run and a real run choose exactly alike.
 */

import semver from "semver";
import { z } from "zod";
import { ConfigError } from "../errors.js";

/** What the registry publishes for the package, reduced to what a choice needs. */
export type RegistryMetadata = {
  /** The package name the registry answered for. */
  name: string;
  /** Every published version that is valid semver, newest first. */
  versions: string[];
  /** Each dist-tag (`latest`, `next`) and the version it points at. */
  distTags: Record<string, string>;
};

/**
 * What the person asked for.
 *
 * - `default`: the newest version in the installed major.
 * - `major`: the newest version, whatever its major.
 * - `spec`: an exact version, a dist-tag name, or a semver range.
 */
export type VersionRequest =
  | { kind: "default" }
  | { kind: "major" }
  | { kind: "spec"; spec: string };

/** How the chosen version relates to the installed one. */
export type VersionDirection = "upgrade" | "downgrade" | "current";

/** The version an install moves to, and how the choice was read. */
export type VersionChoice = {
  /** The version to install; equal to the installed version when `direction` is `current`. */
  target: string;
  direction: VersionDirection;
  /** Whether prerelease versions counted as candidates, after the default was applied. */
  prerelease: boolean;
  /**
   * How a `spec` request was read: an exact version, a dist-tag or a range.
   * Undefined for the other requests.
   */
  specKind?: "version" | "dist-tag" | "range";
};

/** Input to `chooseVersion`. */
export type ChooseVersionInput = {
  /** The version the install holds now. */
  current: string;
  /** Every published version (any order; invalid entries are ignored). */
  versions: readonly string[];
  /** The registry's dist-tags. */
  distTags: Readonly<Record<string, string>>;
  request: VersionRequest;
  /**
   * Whether prerelease versions count as candidates. Undefined means "on when
   * the installed version is itself a prerelease".
   */
  prerelease?: boolean;
};

/** How many of the newest versions an error lists. */
const NEWEST_LISTED = 5;

/**
 * The abbreviated package document, as far as sous reads it. Every other field
 * the registry sends is kept and ignored, so a registry that adds one breaks
 * nothing.
 */
const abbreviatedDocumentSchema = z.looseObject({
  name: z.string(),
  "dist-tags": z.record(z.string(), z.string()).default({}),
  versions: z.record(z.string(), z.unknown()),
});

/**
 * Reads the registry's abbreviated package document (the answer to a request
 * sent with `Accept: application/vnd.npm.install-v1+json`).
 *
 * Keys of `versions` that are not valid semver are dropped, and so is a
 * dist-tag that points at one. A body that is not JSON, or lacks `name` or
 * `versions`, is a ConfigError naming `source`.
 *
 * @param text - The response body.
 * @param source - Where the body came from (the URL), named in errors.
 */
export function parseRegistryMetadata(text: string, source: string): RegistryMetadata {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `The registry's answer from ${source} is not JSON.\n  ${(error as Error).message}`
    );
  }
  const parsed = abbreviatedDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  ${issue.path.join(".") || "(top level)"}: ${issue.message}`
    );
    throw new ConfigError(
      [`The registry's answer from ${source} is not a package document.`, ...problems].join("\n")
    );
  }

  const versions = Object.keys(parsed.data.versions)
    .filter((version) => semver.valid(version) === version)
    .sort(semver.rcompare);
  const distTags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(parsed.data["dist-tags"])) {
    if (semver.valid(version) === version) distTags[tag] = version;
  }
  return { name: parsed.data.name, versions, distTags };
}

/**
 * The range the default request looks in: at least the installed version and
 * below the next major. For a 0.x install that is `<1.0.0`, deliberately NOT
 * caret semantics (which would stop at the next minor): the default is "the
 * newest published version in the current major" (sous-io/sous#135), and a
 * 0.x install's major is 0.
 *
 * The upper bound is written `-0` so a prerelease of the next major
 * (`1.0.0-rc.1`, which sorts below `1.0.0`) is outside it too.
 *
 * defaultRange("0.2.30") -> ">=0.2.30 <1.0.0-0"
 */
export function defaultRange(current: string): string {
  return `>=${current} <${semver.major(current) + 1}.0.0-0`;
}

/**
 * Chooses the version an install moves to.
 *
 * - `default`: the newest candidate in `defaultRange(current)`; nothing newer
 *   means `current`. Never a downgrade.
 * - `major`: the newest candidate overall; when that is older than the
 *   installed version, `current`. Never a downgrade.
 * - `spec`: an exact version (a leading `v` is accepted) that must be
 *   published, a dist-tag's version, or the newest candidate a range admits.
 *   A spec may downgrade, and `direction` then says so.
 *
 * A candidate is a published version that is not a prerelease, or any
 * published version when prereleases are on. An exact version and a dist-tag
 * are taken as named, whatever the prerelease setting.
 *
 * @throws ConfigError when `current` is not a version, or a spec matches
 *   nothing; the message lists the dist-tags and the newest versions.
 */
export function chooseVersion(input: ChooseVersionInput): VersionChoice {
  const current = semver.valid(input.current);
  if (current === null) {
    throw new ConfigError(
      `The installed version "${input.current}" is not a version sous can compare with the published ones.`
    );
  }
  const prerelease = input.prerelease ?? semver.prerelease(current) !== null;
  const published = input.versions.filter((version) => semver.valid(version) === version);
  const candidates = prerelease
    ? published
    : published.filter((version) => semver.prerelease(version) === null);
  const range = { includePrerelease: true };

  const settle = (target: string | null, specKind?: VersionChoice["specKind"]): VersionChoice => {
    const choice: VersionChoice = {
      target: target ?? current,
      direction: directionOf(target ?? current, current),
      prerelease,
    };
    if (specKind !== undefined) choice.specKind = specKind;
    return choice;
  };
  const noDowngrade = (target: string | null): string | null =>
    target !== null && semver.gt(target, current) ? target : null;

  const { request } = input;
  if (request.kind === "default") {
    return settle(noDowngrade(semver.maxSatisfying(candidates, defaultRange(current), range)));
  }
  if (request.kind === "major") {
    return settle(noDowngrade(semver.maxSatisfying(candidates, "*", range)));
  }

  const spec = request.spec.trim();
  const exact = semver.valid(spec);
  if (exact !== null) {
    if (!published.includes(exact)) throw noMatch(spec, "is not a published version", input);
    return settle(exact, "version");
  }
  const tagged = input.distTags[spec];
  if (tagged !== undefined) return settle(tagged, "dist-tag");
  if (semver.validRange(spec) !== null) {
    const newest = semver.maxSatisfying(candidates, spec, range);
    if (newest === null) {
      throw noMatch(
        spec,
        prerelease
          ? "matches no published version"
          : "matches no published version that is not a prerelease",
        input
      );
    }
    return settle(newest, "range");
  }
  throw noMatch(spec, "is not a version, a range or a dist-tag", input);
}

/** How `target` relates to `current`. */
function directionOf(target: string, current: string): VersionDirection {
  const order = semver.compare(target, current);
  if (order > 0) return "upgrade";
  if (order < 0) return "downgrade";
  return "current";
}

/**
 * The error for a spec that names nothing: what was asked, why it matched
 * nothing, and what the registry does publish.
 */
function noMatch(spec: string, why: string, input: ChooseVersionInput): ConfigError {
  const lines = [`The requested version "${spec}" ${why}.`];
  const tags = Object.entries(input.distTags).sort(([a], [b]) => a.localeCompare(b));
  if (tags.length > 0) {
    lines.push("  The dist-tags point at:");
    for (const [tag, version] of tags) lines.push(`    ${tag}: ${version}`);
  }
  const newest = input.versions
    .filter((version) => semver.valid(version) === version)
    .sort(semver.rcompare)
    .slice(0, NEWEST_LISTED);
  if (newest.length > 0) {
    lines.push(`  The newest published versions are ${newest.join(", ")}.`);
  } else {
    lines.push("  The registry lists no published versions.");
  }
  return new ConfigError(lines.join("\n"));
}
