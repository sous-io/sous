import type { Liquid } from "liquidjs";
import { registerBulletListFilter } from "./bullet-list.js";

const filterRegistrars: Array<(engine: Liquid) => void> = [
  registerBulletListFilter,
];

export default filterRegistrars;
