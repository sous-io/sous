/**
 * What the plugin-refs tests share: an engine with plugin-refs and stand-in hosts, the services of
 * one build, and builders for refs and readings.
 *
 * The hosts stand in for the `repository-host` entities plugin-github, plugin-gitlab and
 * plugin-local add, with the location rules of today's providers.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BufferedReporter, definePlugin, type PluginDefinition, type ProjectInfo, type ServiceContext } from "@sous-io/plugin-api";
import { createEngine } from "@sous-io/core";
import { hostPlugin } from "@sous-io/plugin-host";
import refsPlugin from "../src/index.js";
import { buildCanonicalRepository, defaultLocator, readingsAfterRepository, splitRepoUrl, withoutGitSuffix } from "../src/locations/host-helpers.js";
import type {
    LocationReading,
    NamespaceRef,
    PartialRef,
    RecipeRef,
    RefLookupEntity,
    RefsFormat,
    RefsLocations,
    RefsParser,
    RefsPicker,
    RefsResolver,
    RepoRef,
    RepositoryLocator,
    SousRef,
} from "../src/types.js";

/** GitHub: an owner and a name, then whatever is inside. */
export const githubHost: RepositoryLocator = {
    id: "github",
    defaultHost: "github.com",
    readLocation({ segments }) {
        if (segments.length < 2) {
            return [];
        }

        return readingsAfterRepository(`${segments[0]}/${withoutGitSuffix(segments[1]!)}`, segments.slice(2));
    },
    formatLocator: (host, repoPath, rest) => defaultLocator("github", "github.com", host, repoPath, rest),
    matches: (url) => splitRepoUrl(url)?.host === "github.com",
    canonicalize(url) {
        const parts = splitRepoUrl(url);

        if (parts === undefined) {
            throw new Error(`'${url}' is not a github repository URL.`);
        }

        return buildCanonicalRepository(parts.host, parts.owner, parts.name);
    },
};

/** GitLab: nested groups, so a path reads every way that leaves a project of two or more segments. */
export const gitlabHost: RepositoryLocator = {
    id: "gitlab",
    defaultHost: "gitlab.com",
    readLocation({ segments }) {
        const projectPath = (parts: string[]): string =>
            parts.map((segment, index) => (index === parts.length - 1 ? withoutGitSuffix(segment) : segment)).join("/");
        const separator = segments.indexOf("-");

        if (separator >= 2) {
            return readingsAfterRepository(projectPath(segments.slice(0, separator)), segments.slice(separator));
        }

        const suffixed = segments.findIndex((segment) => /\.git$/i.test(segment));

        if (suffixed >= 1) {
            return readingsAfterRepository(projectPath(segments.slice(0, suffixed + 1)), segments.slice(suffixed + 1));
        }

        const readings: LocationReading[] = [];

        for (let end = 2; end <= segments.length; end++) {
            const rest = segments.slice(end);

            if (rest.length <= 2) {
                readings.push({ repoPath: projectPath(segments.slice(0, end)), named: rest });
            }
        }

        return readings;
    },
    formatLocator(host, repoPath, rest) {
        const where = host === "gitlab.com" ? repoPath : `${host}/${repoPath}`;

        return `gitlab://${where}${rest.length === 0 ? "" : `/-/${rest}`}`;
    },
    matches(url) {
        const host = splitRepoUrl(url)?.host;

        return host !== undefined && (host === "gitlab.com" || host.startsWith("gitlab."));
    },
    canonicalize(url) {
        const parts = splitRepoUrl(url);

        if (parts === undefined) {
            throw new Error(`'${url}' is not a gitlab repository URL.`);
        }

        return buildCanonicalRepository(parts.host, parts.owner, parts.name);
    },
};

/** A local directory, named by an absolute path or a `file://` URL. */
export const localHost: RepositoryLocator = {
    id: "local",
    readLocation: () => [],
    formatLocator: (_host, repoPath, rest) => `file://${repoPath}${rest.length === 0 ? "" : `/${rest}`}`,
    matches: (url) => url.startsWith("/") || url.startsWith("file://"),
    canonicalize(url) {
        const directory = url.startsWith("file://") ? fileURLToPath(url) : url;

        return {
            host: "localhost",
            owner: path.dirname(directory),
            name: path.basename(directory),
            httpsUrl: directory,
            sshUrl: pathToFileURL(directory).href,
        };
    },
};

/** A plugin adding the stand-in hosts as `repository-host` entities. */
export function hostsPlugin(hosts: readonly RepositoryLocator[] = [githubHost, gitlabHost, localHost]): PluginDefinition {
    return definePlugin({
        name: "test-hosts",
        version: "1.0.0",
        register(sous) {
            for (const host of hosts) {
                sous.entities.add("repository-host", host as unknown as Record<string, unknown> & { id: string });
            }
        },
    });
}

/** A plugin adding `ref-lookup` entities. */
export function lookupsPlugin(...lookups: RefLookupEntity[]): PluginDefinition {
    return definePlugin({
        name: "test-lookups",
        version: "1.0.0",
        register(sous) {
            for (const lookup of lookups) {
                sous.entities.add("ref-lookup", lookup);
            }
        },
    });
}

/** The services of one build, and the context a service factory gets. */
export interface Refs {
    parser: RefsParser;
    resolver: RefsResolver;
    picker: RefsPicker;
    format: RefsFormat;
    locations: RefsLocations;
    ctx: ServiceContext;
    reporter: BufferedReporter;
}

/** Builds a config with plugin-refs, the stand-in hosts and any other plugins, and returns its services. */
export async function buildRefs(options: { plugins?: PluginDefinition[]; hosts?: readonly RepositoryLocator[]; project?: ProjectInfo } = {}): Promise<Refs> {
    let captured: ServiceContext | undefined;
    const probe = definePlugin({
        name: "test-probe",
        version: "1.0.0",
        register(sous) {
            sous.services.add("test.context", (_config, ctx) => (captured = ctx));
        },
    });
    const reporter = new BufferedReporter();
    const engine = createEngine({
        builtIns: [hostPlugin, refsPlugin, hostsPlugin(options.hosts), ...(options.plugins ?? []), probe],
        reporter,
        ...(options.project === undefined ? {} : { project: options.project }),
    });
    const built = await engine.buildConfig();

    built.services.get("test.context");

    return {
        parser: built.services.get("refs.parser"),
        resolver: built.services.get("refs.resolver"),
        picker: built.services.get("refs.picker"),
        format: built.services.get("refs.format"),
        locations: built.services.get("refs.locations"),
        ctx: captured!,
        reporter,
    };
}

/** An unread reading of some text, with an empty problem list. */
export function stateOf(rest: string, extra: Partial<PartialRef> = {}): PartialRef {
    return { input: rest, rest, problems: [], ...extra };
}

/** A repository ref known by short name. */
export function repoRef(name: string): RepoRef {
    return { kind: "repo", name };
}

/** A namespace ref, optionally inside a repository known by short name. */
export function nsRef(name: string, repo?: string): NamespaceRef {
    return { kind: "namespace", name, ...(repo === undefined ? {} : { repo: repoRef(repo) }) };
}

/** A recipe ref with its namespace, optionally inside a repository known by short name. */
export function recipeRef(namespace: string, name: string, repo?: string): RecipeRef {
    return { kind: "recipe", name, namespace: nsRef(namespace, repo) };
}

/** Every ref printed in its canonical form, with its kind. */
export function printed(format: RefsFormat, refs: readonly SousRef[]): string[] {
    return refs.map((ref) => `${ref.kind}:${format.format(ref)}`);
}
