import type { Liquid } from "liquidjs";
import { registerShowVarsTag } from "./showVars.js";
import { registerExportScalarVarsJsTag } from "./exportScalarVarsJs.js";
import { registerGetFilesTag } from "./getFiles.js";
import { registerListFilesTag } from "./listFiles.js";

const tagRegistrars: Array<(engine: Liquid) => void> = [
  registerShowVarsTag,
  registerExportScalarVarsJsTag,
  registerGetFilesTag,
  registerListFilesTag,
];

export default tagRegistrars;
