/**
 * Where the ladder's inputs come from: the names service, the env files, the engine's environment
 * and the `varMappings` config key. One place builds a ladder, so the services, the
 * `variable-source` entity and the intents read answers the same way.
 */

import type { Environment, ServiceReader } from "@sous-io/plugin-api";
import type { VariableDefinition } from "@sous-io/plugin-formats/types";
import type { EnvFileKind } from "@sous-io/plugin-config-files/types";
import type { ConfigLookup } from "@sous-io/plugin-variables/types";
import { Ladder, layersFrom } from "./ladder.js";

/** What building a ladder reads. */
export interface LadderInputs {
    readonly services: Pick<ServiceReader, "get" | "has">;
    readonly env: Environment;
    readonly config: ConfigLookup;
}

/** A new ladder over the env files as they are now and the mapping records in the config. */
export function buildLadder(inputs: LadderInputs): Ladder {
    const files = inputs.services.has("config-files.env") ? inputs.services.get("config-files.env").readSync() : undefined;

    return new Ladder(inputs.services.get("variables.names"), layersFrom(files, inputs.env), inputs.config.get<Record<string, string>>("varMappings") ?? {});
}

/** The env file a definition's answer belongs in: secrets and local values go in the gitignored one. */
export function answerFileFor(definition: Pick<VariableDefinition, "secret" | "scope">): EnvFileKind {
    return definition.secret || definition.scope === "local" ? "local" : "shared";
}

/** What is shown for a variable nothing has answered. */
export const UNANSWERED_VALUE = "(unanswered)";

/** A value as it may be shown: a secret never is, so no recording or scrollback leaks one. */
export function displayValue(value: string | undefined, secret: boolean, hidden: string): string {
    if (value === undefined) {
        return UNANSWERED_VALUE;
    }

    return secret ? hidden : value;
}

/** What a hidden value prints as, from `variables.secrets`. */
export function hiddenValue(services: Pick<ServiceReader, "get" | "has">): string {
    return services.has("variables.secrets") ? services.get("variables.secrets").hiddenValue : "(hidden)";
}
