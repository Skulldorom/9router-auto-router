"use strict";

const DEFAULTS = Object.freeze({ easyTarget: "coder", hardTarget: "coder-high", hardThreshold: 6, longContextChars: 24000, largeToolResultChars: 12000, manyTools: 16, verbose: false, jevTimeoutMs: 1500 });
const NUMERIC_BOUNDS = Object.freeze({
  hardThreshold: Object.freeze({ min: 1, max: 100 }),
  longContextChars: Object.freeze({ min: 1, max: 10000000 }),
  largeToolResultChars: Object.freeze({ min: 1, max: 10000000 }),
  manyTools: Object.freeze({ min: 1, max: 10000 }),
  jevTimeoutMs: Object.freeze({ min: 100, max: 10000 }),
});

module.exports = { DEFAULTS, NUMERIC_BOUNDS };
