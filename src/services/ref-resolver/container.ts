/**
 * The Inversify container of the ref services.
 *
 * Every part is bound once and shared: the parser, every splitter, every
 * pruner, the resolver and the picker. Splitters, pruners and providers are
 * bound many times under one token each (`REF_TOKENS`), and the parser and the
 * resolver receive them as lists, so a plugin adds a splitter, a pruner or a
 * provider by binding one more under the same token on a container it builds
 * with `createRefContainer()`:
 *
 *     const container = createRefContainer();
 *     container.bind(REF_TOKENS.Splitter).to(MyNewFormSplitter);
 *     const resolver = container.get<RefResolverService>(REF_TOKENS.Resolver);
 *
 * The `#` names are bound the same way: one more `HashName` under
 * `REF_TOKENS.HashName` registers a view or a built-in, and a name bound twice
 * is an error when the registry is first read.
 *
 * Callers that have no container of their own use `sharedRefResolver`,
 * `sharedHashNames` and `sharedRefPicker`, which come from one container built the first time they
 * are read.
 */

import { Container } from "inversify";
import { builtInProviders } from "../../lib/repos/providers/index.js";
import { EnvVarSplitter } from "./parser/env-var-splitter.js";
import { LocationSplitter } from "./parser/location-splitter.js";
import { NamePathSplitter } from "./parser/name-path-splitter.js";
import { QuerySplitter } from "./parser/query-splitter.js";
import { RangeSplitter } from "./parser/range-splitter.js";
import { RefParser } from "./parser/ref-parser.js";
import { RepoQualifierSplitter } from "./parser/repo-qualifier-splitter.js";
import { CommandLinePruner } from "./pruners/command-line-pruner.js";
import { IncludePruner } from "./pruners/include-pruner.js";
import { ManifestPruner } from "./pruners/manifest-pruner.js";
import { ConfigPruner, LockfilePruner } from "./pruners/stored-key-pruner.js";
import { MemoriesHashName } from "../../lib/repos/memories-hash-name.js";
import { HashNameRegistry, ProjectHashName } from "./hash-names.js";
import { RefPickerService } from "./ref-picker-service.js";
import { RefResolverService } from "./ref-resolver-service.js";
import { REF_TOKENS } from "./tokens.js";

/**
 * Builds a container holding every ref service. Each call returns a fresh
 * container, so a plugin or a test may bind more splitters or pruners without
 * touching anyone else's.
 */
export function createRefContainer(): Container {
  const container = new Container({ defaultScope: "Singleton" });

  for (const provider of builtInProviders()) {
    container.bind(REF_TOKENS.Provider).toConstantValue(provider);
  }

  for (const splitter of [
    QuerySplitter,
    RangeSplitter,
    LocationSplitter,
    RepoQualifierSplitter,
    NamePathSplitter,
    EnvVarSplitter,
  ]) {
    container.bind(REF_TOKENS.Splitter).to(splitter);
  }

  for (const pruner of [
    CommandLinePruner,
    ConfigPruner,
    ManifestPruner,
    LockfilePruner,
    IncludePruner,
  ]) {
    container.bind(REF_TOKENS.Pruner).to(pruner);
  }

  container.bind(REF_TOKENS.HashName).to(ProjectHashName);
  container.bind(REF_TOKENS.HashName).to(MemoriesHashName);
  container.bind(REF_TOKENS.HashNames).to(HashNameRegistry);
  container.bind(REF_TOKENS.Parser).to(RefParser);
  container.bind(REF_TOKENS.Resolver).to(RefResolverService);
  container.bind(REF_TOKENS.Picker).to(RefPickerService);
  return container;
}

/** The container the shared instances come from, built on first use. */
let sharedContainer: Container | undefined;

/** The one container callers with no container of their own share. */
export function getSharedRefContainer(): Container {
  sharedContainer ??= createRefContainer();
  return sharedContainer;
}

/** The shared resolver, for callers that have no container. */
export function sharedRefResolver(): RefResolverService {
  return getSharedRefContainer().get<RefResolverService>(REF_TOKENS.Resolver);
}

/** The shared registry of `#` names, for callers that have no container. */
export function sharedHashNames(): HashNameRegistry {
  return getSharedRefContainer().get<HashNameRegistry>(REF_TOKENS.HashNames);
}

/** The shared picker, for callers that have no container. */
export function sharedRefPicker(): RefPickerService {
  return getSharedRefContainer().get<RefPickerService>(REF_TOKENS.Picker);
}
