const assert = require("node:assert");
const { add } = require("./math.js");

assert.strictEqual(add(2, 3), 5, "add(2,3) should be 5");
console.log("All tests passed");
