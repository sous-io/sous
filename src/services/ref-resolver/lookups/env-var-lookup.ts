import type { DefinedVariable } from "../../../lib/vars/definition-source.js";
import { variableCandidates, type LadderContext } from "../../../lib/vars/ladder.js";
import { bareName } from "../../../lib/vars/names.js";
import type { SousRef, VariableRef } from "../types.js";
import type { RefLookup, RefMatch } from "./ref-lookup.js";
import { variableRefOf } from "./variable-lookup.js";

/**
 * Answers an environment variable name with the variables it answers.
 *
 * A name is held whole and compared in its exact spelling only, because a
 * variable (`apiUrl`) and an environment variable name can differ only in case
 * and the spelling typed is the one meant. The names searched are the one each
 * definition declares (a recipe may bind an existing variable such as
 * `GITHUB_TOKEN`) plus every generated name on the resolution ladder that is
 * actually in use in `.sous/.env` or `.sous/.env.local`; generated names are
 * only searched when in use, because every variable generates several and a
 * project would otherwise be told that a name nothing has ever set names one of
 * its variables.
 */
export class EnvVarLookup implements RefLookup {
  private readonly byName = new Map<string, VariableRef[]>();

  /**
   * @param variables - The variable definitions in play.
   * @param ladder - The environment layers, which decide which generated names are in use.
   */
  constructor(variables: DefinedVariable[], ladder?: LadderContext) {
    const inUse =
      ladder === undefined
        ? new Set<string>()
        : new Set([...Object.keys(ladder.localEnv), ...Object.keys(ladder.sharedEnv)]);

    for (const defined of variables) {
      const names = new Set<string>([bareName(defined.definition)]);
      if (ladder !== undefined) {
        for (const candidate of variableCandidates(defined, ladder)) {
          if (inUse.has(candidate.envName)) names.add(candidate.envName);
        }
      }
      for (const name of names) {
        const answered = this.byName.get(name) ?? [];
        answered.push(variableRefOf(defined));
        this.byName.set(name, answered);
      }
    }
  }

  async find(candidate: SousRef): Promise<RefMatch[]> {
    if (candidate.kind !== "envVar") return [];
    const variables = this.byName.get(candidate.name);
    if (variables === undefined) return [];
    return [
      {
        ref: {
          kind: "envVar",
          name: candidate.name,
          variables,
          ...(candidate.vars === undefined ? {} : { vars: candidate.vars }),
        },
        exactSpelling: true,
      },
    ];
  }
}
