/**
 * The contract of plugin-liquid: building a configured LiquidJS
 * engine with every tag and filter plugins add. The compiler renders templates with it, and
 * config expressions evaluate with it. It also finds a template's top-level Liquid sections and
 * cuts a render's output back into one piece per section.
 *
 * Other plugins import this file type-only.
 */

import type { Environment, EntityReader, ProjectInfo, ServiceReader } from "@sous-io/plugin-api";
import type { FS, FilterImplOptions, Liquid, LiquidOptions } from "liquidjs";

export type { FS, FilterImplOptions, Liquid, LiquidOptions };

/** What `Liquid.registerTag` takes: a tag class, or the options LiquidJS turns into one. */
export type LiquidTagImplementation = Parameters<Liquid["registerTag"]>[1];

/** What a tag's or filter's factory gets when an engine is built. */
export interface LiquidExtensionContext {
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    readonly services: ServiceReader;
    readonly entities: EntityReader;
    /** What the engine is for: `config-expression`, `template`, or a plugin's own purpose. */
    readonly purpose: LiquidPurpose;
    /** Names declared secret, which tags that dump a scope must hide. */
    readonly secretNames: ReadonlySet<string>;
    /** Whatever the code building the engine handed over (the compiler hands its include context). */
    readonly data: Readonly<Record<string, unknown>>;
}

/** Why an engine is built. */
export type LiquidPurpose = "config-expression" | "template" | (string & {});

/** A `liquid-tag` entity: a Liquid tag any plugin adds. */
export interface LiquidTagEntity {
    /** The tag's name, as written in `{% name %}`. */
    id: string;
    /** What it does, for `plugins show`. */
    description?: string;
    /** The purposes it is registered for. Default: every purpose except `config-expression`. */
    purposes?: readonly LiquidPurpose[];
    /** Makes the tag for one engine. */
    tag(ctx: LiquidExtensionContext): LiquidTagImplementation;
}

/** A `liquid-filter` entity: a Liquid filter any plugin adds; config expressions see it too. */
export interface LiquidFilterEntity {
    /** The filter's name, as written after `|`. */
    id: string;
    description?: string;
    /** The purposes it is registered for. Default: every purpose, config expressions included. */
    purposes?: readonly LiquidPurpose[];
    /** Makes the filter for one engine. A filter config expressions use must give the same result for the same input. */
    filter(ctx: LiquidExtensionContext): FilterImplOptions;
}

/** How to build one engine. */
export interface LiquidEngineOptions {
    /** Default `template`. */
    purpose?: LiquidPurpose;
    /** The file system Liquid reads `{% render %}` and `{% include %}` paths through (the compiler's include resolution). */
    fs?: FS;
    /** Directories partials are looked up in. */
    root?: string | readonly string[];
    /** Names declared secret. */
    secretNames?: Iterable<string>;
    /** Handed to every tag and filter factory as `ctx.data`. */
    data?: Readonly<Record<string, unknown>>;
    /** Only these tags and filters, by id; default every one whose `purposes` allow it. */
    only?: { tags?: readonly string[]; filters?: readonly string[] };
    /** Any other LiquidJS option, passed through. */
    liquid?: Omit<LiquidOptions, "fs" | "root">;
}

/** Building configured LiquidJS engines. */
export interface LiquidEngines {
    /** A new engine with every tag and filter the entities add. */
    create(options?: LiquidEngineOptions): Liquid;
    /** The ids of every tag and filter an engine of a purpose gets. */
    available(purpose?: LiquidPurpose): { tags: string[]; filters: string[] };
}

/**
 * One top-level Liquid section of a template: an output (`{{ name }}`), a single tag
 * (`{% assign x = 1 %}`), or a whole block from its opening tag to its matching end tag
 * (`{% if %}...{% endif %}`). Anything nested inside a block belongs to that block.
 */
export interface LiquidRegion {
    /** Where the section starts in the source. */
    from: number;
    /** Where it ends in the source (exclusive). */
    to: number;
    kind: "output" | "tag" | "block";
    /** The tag's name, or an output's expression. */
    label: string;
    /** The opening tag's text, or the whole output, e.g. `{% if x == "y" %}`. */
    head: string;
    /** For if, unless, case, for and tablerow blocks: each branch's tag text (a loop's body is `body`). */
    branches?: string[];
    /** Where each branch's content starts in the source, after any whitespace a `-%}` trims. */
    branchPoints?: number[];
}

/** A section after a render: what it printed, and how often each branch ran. */
export interface RenderedRegion extends Omit<LiquidRegion, "branchPoints"> {
    /** The section's output. */
    rendered: string;
    /** How many times each branch ran, matching `branches` (a loop's body count is its number of loops). */
    ran?: number[];
}

/** Where one section's output sits in the whole output. */
export interface RegionSegment {
    start: number;
    end: number;
    /** The section's index in `regions`. */
    region: number;
}

/** A source with invisible markers around each section, ready to render. */
export interface MarkedSource {
    /** The source with markers added. Render this instead of the original. */
    source: string;
    /** The marker's random part, so text in the template cannot pass for a marker. */
    nonce: string;
    /** The sections the markers wrap, in order. */
    regions: LiquidRegion[];
}

/** A marked render cut apart. */
export interface RegionRender {
    /** The output with every marker removed. */
    output: string;
    /** Each section with its output and the branches that ran. */
    regions: RenderedRegion[];
    /** Where each section's output sits in `output`. A section that never finished has none. */
    segments: RegionSegment[];
}

/** A problem in a template, said plainly, with where it is. */
export interface LiquidProblem {
    message: string;
    /** The offset in the source, or null when LiquidJS did not say. */
    pos: number | null;
}

/** Options for the methods that need an engine. */
export interface LiquidRegionOptions {
    /**
     * The engine the template renders with, for its delimiters, tags and filters. Default: a
     * template engine from `liquid.engine`, built once per service object.
     */
    engine?: Liquid;
}

/**
 * Finding a template's top-level Liquid sections, and cutting a render's output back into one
 * piece per section. Rendering is the caller's: render `mark(source).source`, then hand the
 * output to `split`.
 */
export interface LiquidRegions {
    /** The top-level Liquid sections of a template, in order. Throws LiquidJS's error when the source does not tokenize. */
    find(source: string, options?: LiquidRegionOptions): LiquidRegion[];
    /** Wraps every section in invisible markers, for a render whose output `split` cuts apart. Throws like `find`. */
    mark(source: string, options?: LiquidRegionOptions): MarkedSource;
    /** Cuts a marked render's output into the plain output plus, per section, its output and the branches that ran. */
    split(output: string, marked: MarkedSource): RegionRender;
    /** The variables a template reads and does not set itself, or undefined when a tag stops LiquidJS telling. */
    uses(source: string, options?: LiquidRegionOptions): string[] | undefined;
    /**
     * A LiquidJS error in plain words, with its offset in `source`. Pass `marked` when the error came
     * from rendering `marked.source`, so the offset leaves out the markers.
     */
    describeError(error: unknown, source: string, marked?: MarkedSource): LiquidProblem;
    /**
     * The first mistake that does not stop a render: a filter the engine does not have (LiquidJS
     * passes the input through unchanged), or a `|` with no filter name after it.
     */
    warning(source: string, options?: LiquidRegionOptions): LiquidProblem | undefined;
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** Building LiquidJS engines. */
        "liquid.engine": LiquidEngines;
        /** Finding a template's Liquid sections and cutting a render's output into them. */
        "liquid.regions": LiquidRegions;
    }

    interface SousEntities {
        /** A Liquid tag. */
        "liquid-tag": LiquidTagEntity;
        /** A Liquid filter. */
        "liquid-filter": LiquidFilterEntity;
    }
}
