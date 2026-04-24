import type { Liquid } from "liquidjs";
import { registerShowVarsTag } from "./showVars.js";

const tagRegistrars: Array<(engine: Liquid) => void> = [
  registerShowVarsTag,
];

export default tagRegistrars;
