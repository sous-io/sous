import { DataValue, IntentOutput, IntentOutputs, TextBlock } from "@sous-io/plugin-api";

/** Outputs holding a plain object: shown as JSON, and what `--json` and a calling intent read. */
export function data<T extends object>(value: T): IntentOutputs<T> {
    return IntentOutputs.of(value, { result: new DataValue(value) });
}

/** Outputs holding one text, shown exactly as given. */
export function text(value: string): IntentOutputs {
    return new IntentOutputs(new IntentOutput({ result: new TextBlock(value, { verbatim: true }) }));
}

/** Outputs holding nothing to show. */
export function nothing(): IntentOutputs {
    return new IntentOutputs();
}
