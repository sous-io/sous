import root from "../../eslint.config.js";

export default [
  ...root,
  {
    ignores: ["dist/**", "coverage/**"],
  },
];
