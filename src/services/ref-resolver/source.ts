/**
 * Where a ref was written. The parser reads every form wherever a ref comes
 * from, and the place decides which of those forms it allows: the pruner for
 * that place drops the readings it refuses, saying what to write there instead.
 */
export enum RefSource {
  /**
   * A ref typed on the command line. Every form is allowed: a bare name, a
   * namespace and recipe, a `repo:` qualifier, a version range, a
   * provider-scheme locator, an HTTPS, SSH or scheme-less URL, and a browser
   * URL copied from a host's file view. Names may be written in any case.
   */
  CommandLine = "commandLine",
  /**
   * A subscription key in a config layer. Only the stored form is allowed:
   * `namespace` or `namespace/recipe`, lowercase. The repository a
   * subscription resolves into is recorded in the lockfile, and its range in
   * the entry's own `range` field.
   */
  Config = "config",
  /**
   * An entry of a recipe manifest's `depends` or `subscribes` list. A bare ref
   * names a recipe in the same repository; every locator and URL form names
   * one in another repository. A `repo:` qualifier is refused, because it is
   * one project's private name for a repository, and so is a local path.
   */
  Manifest = "manifest",
  /**
   * A key sous wrote itself: the lockfile, the index and the store. Only the
   * canonical `namespace` or `namespace/recipe` is allowed.
   */
  Lockfile = "lockfile",
  /**
   * The path of a template include line, once its sigil is taken off. Only a
   * file inside a recipe is allowed (`namespace/recipe/path`), and the path may
   * be a glob.
   */
  Include = "include",
}

/** What each place is called in a sentence. */
export const SOURCE_LABELS: Record<RefSource, string> = {
  [RefSource.CommandLine]: "on the command line",
  [RefSource.Config]: "as a subscription key in a config file",
  [RefSource.Manifest]: "in a recipe manifest's 'depends' or 'subscribes' list",
  [RefSource.Lockfile]: "as a key sous stores",
  [RefSource.Include]: "in an include line",
};
