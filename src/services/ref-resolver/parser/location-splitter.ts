/**
 * Reads a repository written as a location: a URL, an SSH remote, a
 * provider-scheme locator or a host path.
 *
 * Nothing host-specific lives here. Where a repository path ends and what a
 * browser path looks like are each provider's own rule, asked through
 * `RepoProvider.readLocation`, which may answer more than one way (a GitLab
 * nested group does not say where the project path ends).
 */

import { makeInjectable } from "../injectable.js";
import { REF_TOKENS } from "../tokens.js";
import {
  detectProvider,
  providerById,
  type RepoProvider,
} from "../../../lib/repos/providers/index.js";
import { locationFor } from "../location.js";
import type { RepoRef } from "../types.js";
import { BaseRefSplitter, finishRef, type PartialRef } from "./partial-ref.js";

/** A URL that names its scheme, such as `https://` or `github://`. */
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;

/** The `scp`-style SSH form, as in `git@github.com:owner/name.git`. */
const SCP_PATTERN = /^[^@\s/:]+@([^@\s/:]+):(.+)$/s;

/** Schemes that are ordinary URLs rather than a provider's own identifier. */
const URL_SCHEMES = new Set(["http", "https", "ssh", "git", "git+ssh", "ssh+git"]);

/** Schemes that name a repository on this machine. */
const LOCAL_SCHEMES = new Set(["local", "file"]);

/**
 * True when a written ref names a location (a URL, an SSH remote, a
 * provider-scheme locator or a host path) rather than a short name. A short
 * name never carries `://`, an `@` before a `:`, or a dot in its first segment.
 *
 * @param ref - The ref as written.
 */
export function looksLikeLocation(ref: string): boolean {
  const trimmed = ref.trim();
  if (SCHEME_PATTERN.test(trimmed)) return true;
  if (SCP_PATTERN.test(trimmed)) return true;
  const first = trimmed.split("/")[0] ?? "";
  return trimmed.includes("/") && first.includes(".") && !first.includes(":");
}

/** A location, taken apart only as far as every host agrees. */
type Taken = { provider: RepoProvider; host: string; segments: string[] };

/** A URL path's segments, decoded, with empty ones dropped. */
function pathSegments(pathname: string): string[] {
  return pathname
    .split(/[?#]/)[0]!
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter((segment) => segment.length > 0);
}

/**
 * Reads a location into a repository, and whatever is named inside it. A
 * repository that a short name does not already qualify gets the location; the
 * names after it are left in `rest` for the name splitter, and a browser path
 * becomes a finished repository ref of its own.
 */
export class LocationSplitter extends BaseRefSplitter {
  readonly order = 300;

  /**
   * @param providers - The providers that read locations.
   */
  constructor(private readonly providers: RepoProvider[]) {
    super();
  }

  protected read(state: PartialRef): PartialRef[] {
    if (state.repo !== undefined || !looksLikeLocation(state.rest)) return [state];

    const body = state.rest;
    const scheme = SCHEME_PATTERN.exec(body);
    if (scheme !== null && LOCAL_SCHEMES.has(scheme[1]!.toLowerCase())) {
      return [this.local(state, scheme[2]!)];
    }

    const taken = this.take(state, body, scheme);
    if (taken === undefined) return [];

    const { provider, host, segments } = taken;
    const specific: PartialRef[] = [];
    const repositories: RepoRef[] = [];

    for (const reading of provider.readLocation({ host, segments })) {
      const location = locationFor(provider, host, reading.repoPath);
      if (location === undefined) continue;

      if (reading.browsed !== undefined) {
        const browsed = reading.browsed.replace(/^\/+|\/+$/g, "");
        if (browsed.length === 0) continue;
        specific.push(
          finishRef(state, {
            kind: "repo",
            location,
            browsed,
            ...(state.range === undefined ? {} : { range: state.range }),
          })
        );
        continue;
      }

      const named = reading.named ?? [];
      if (named.length === 0) {
        repositories.push({ kind: "repo", location });
        continue;
      }
      specific.push({ ...state, rest: named.join("/"), repo: { kind: "repo", location } });
    }

    // A reading of the whole repository is only kept when nothing more
    // specific was read, because a namespace or a recipe is what a ref is for.
    if (specific.length > 0) return specific;

    if (repositories.length === 0) {
      state.problems.push(
        `the ${provider.id} provider cannot read a namespace or a recipe from this location. ` +
          `After the repository, a location names a namespace and optionally a recipe, as in ` +
          `'${provider.formatLocator(host, "owner/repository", "workflow/alpha")}'.`
      );
      return [];
    }
    if (state.range !== undefined) {
      state.problems.push("a version range applies to a recipe, not to a repository.");
      return [];
    }
    return repositories.map((repo) => finishRef(state, repo));
  }

  /** A repository on this machine: kept as a location the pruners can refuse. */
  private local(state: PartialRef, path: string): PartialRef {
    return finishRef(state, {
      kind: "repo",
      location: {
        provider: "local",
        host: "localhost",
        repoPath: path,
        identity: `localhost/${path.replace(/^\/+/, "")}`,
        url: state.rest,
      },
    });
  }

  /**
   * Takes the host-agnostic parts out of a location: which provider reads it,
   * the host, and the path segments after the host. Records why not, and
   * returns nothing, when the location cannot be read.
   */
  private take(
    state: PartialRef,
    body: string,
    scheme: RegExpExecArray | null
  ): Taken | undefined {
    const providers = this.providers;
    const known = providers
      .filter((provider) => provider.defaultHost !== undefined)
      .map((provider) => provider.id)
      .sort()
      .join(", ");

    if (scheme !== null) {
      const name = scheme[1]!.toLowerCase();

      if (URL_SCHEMES.has(name)) {
        let url: URL;
        try {
          url = new URL(body);
        } catch {
          state.problems.push("the URL could not be read.");
          return undefined;
        }
        const host = url.host.toLowerCase();
        const segments = pathSegments(url.pathname);
        return this.forHost(state, host, segments);
      }

      const provider = providerById(name, providers);
      if (provider === undefined || provider.defaultHost === undefined) {
        state.problems.push(
          `'${name}' is not a provider sous can read a location from. The scheme of a locator ` +
            `is the provider's own identifier; sous ships these: ${known}. An ordinary ` +
            "'https://' URL works too."
        );
        return undefined;
      }
      let segments = pathSegments(scheme[2]!);
      let host = provider.defaultHost;
      if (segments[0]?.includes(".") === true) {
        host = segments[0].toLowerCase();
        segments = segments.slice(1);
      }
      return { provider, host, segments };
    }

    const scp = SCP_PATTERN.exec(body);
    if (scp !== null) {
      return this.forHost(state, scp[1]!.toLowerCase(), pathSegments(scp[2]!));
    }

    const all = pathSegments(body);
    return this.forHost(state, all[0]!.toLowerCase(), all.slice(1));
  }

  /** The provider that recognizes a host, asked with the URL the location would start with. */
  private forHost(state: PartialRef, host: string, segments: string[]): Taken | undefined {
    const probe = `https://${host}/${segments.slice(0, 2).join("/")}`;
    const provider = detectProvider(probe, this.providers);
    if (provider !== undefined && provider.defaultHost !== undefined) {
      return { provider, host, segments };
    }
    const ids = this.providers
      .filter((entry) => entry.defaultHost !== undefined)
      .map((entry) => entry.id)
      .sort();
    state.problems.push(
      `sous does not recognize the host '${host}'. For a self-hosted instance, write the ` +
        `location with the provider's scheme and the host, as in ` +
        `'${ids[0] ?? "gitlab"}://${host}/owner/repository/namespace/recipe' (sous ships these ` +
        `providers: ${ids.join(", ")}).`
    );
    return undefined;
  }
}

makeInjectable(LocationSplitter, [{ multi: REF_TOKENS.Provider }]);
