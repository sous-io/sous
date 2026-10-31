import type { Environment } from "@sous-io/plugin-api";

/** Paints a piece of text, or returns it as it is when color is off. */
export type Paint = (text: string) => string;

/**
 * Every color the CLI writes, in one place (ported from `palette` in today's
 * `src/utils/formatting.ts`): a label is cyan, the value beside it bright white, an aside grey, a
 * warning bright yellow with its sharpest words orange, an explanation bright teal, an error bright
 * red. The raw colors are here too, for code that needs them.
 */
export interface Style {
    /** Whether any of these paints. */
    readonly enabled: boolean;
    /** The name in a key and value pair. */
    readonly label: Paint;
    /** The value beside a label. */
    readonly value: Paint;
    /** A trailing aside: a location, a provenance, anything secondary. */
    readonly muted: Paint;
    /** The body of a warning. */
    readonly warning: Paint;
    /** The words inside a warning that carry the risk. */
    readonly highlight: Paint;
    /** An explanatory line that is neither a warning nor an error. */
    readonly note: Paint;
    /** The body of an error. */
    readonly error: Paint;
    /** A heading (`▶ Building the project:`). */
    readonly heading: Paint;
    /** A subheading (`➔ Target 1:`). */
    readonly subheading: Paint;
    /** The `WARNING:` banner. */
    readonly banner: Paint;
    readonly cyan: Paint;
    readonly cyanBright: Paint;
    readonly green: Paint;
    readonly greenBright: Paint;
    readonly yellow: Paint;
    readonly yellowBright: Paint;
    readonly magenta: Paint;
    readonly red: Paint;
    readonly redBright: Paint;
    readonly white: Paint;
    readonly whiteBright: Paint;
    readonly gray: Paint;
    readonly dim: Paint;
    readonly bold: Paint;
}

function sgr(open: string, close: string): Paint {
    return (text) => `\u001b[${open}m${text}\u001b[${close}m`;
}

const identity: Paint = (text) => text;

const PAINTS = {
    cyan: sgr("36", "39"),
    cyanBright: sgr("96", "39"),
    green: sgr("32", "39"),
    greenBright: sgr("92", "39"),
    yellow: sgr("33", "39"),
    yellowBright: sgr("93", "39"),
    magenta: sgr("35", "39"),
    red: sgr("31", "39"),
    redBright: sgr("91", "39"),
    white: sgr("37", "39"),
    whiteBright: sgr("97", "39"),
    gray: sgr("90", "39"),
    dim: sgr("2", "22"),
    bold: sgr("1", "22"),
    orange: sgr("38;5;208", "39"),
};

/** The colors, painting when `enabled` and leaving text alone when not. */
export function createStyle(enabled: boolean): Style {
    const paint = (fn: Paint): Paint => (enabled ? fn : identity);

    return {
        enabled,
        label: paint(PAINTS.cyan),
        value: paint(PAINTS.whiteBright),
        muted: paint(PAINTS.gray),
        warning: paint(PAINTS.yellowBright),
        highlight: paint(PAINTS.orange),
        note: paint(PAINTS.cyanBright),
        error: paint(PAINTS.redBright),
        heading: paint(PAINTS.yellowBright),
        subheading: paint(PAINTS.whiteBright),
        banner: paint((text) => `\u001b[103m\u001b[30m${text}\u001b[39m\u001b[49m`),
        cyan: paint(PAINTS.cyan),
        cyanBright: paint(PAINTS.cyanBright),
        green: paint(PAINTS.green),
        greenBright: paint(PAINTS.greenBright),
        yellow: paint(PAINTS.yellow),
        yellowBright: paint(PAINTS.yellowBright),
        magenta: paint(PAINTS.magenta),
        red: paint(PAINTS.red),
        redBright: paint(PAINTS.redBright),
        white: paint(PAINTS.white),
        whiteBright: paint(PAINTS.whiteBright),
        gray: paint(PAINTS.gray),
        dim: paint(PAINTS.dim),
        bold: paint(PAINTS.bold),
    };
}

/**
 * Whether output to a stream is colored: `FORCE_COLOR` (anything but `0`) turns it on, `NO_COLOR`
 * off, and otherwise a terminal is colored and a pipe is not.
 */
export function colorEnabled(stream: { readonly isTTY?: boolean }, env: Environment): boolean {
    const force = env.FORCE_COLOR;

    if (force !== undefined && force !== "") {
        return force !== "0" && force !== "false";
    }

    if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
        return false;
    }

    return stream.isTTY === true && env.TERM !== "dumb";
}
