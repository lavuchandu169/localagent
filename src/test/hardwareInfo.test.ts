import { recommendModel } from "../electron/hardwareInfo.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log("Hardware-based model recommendation:");

const GB = 1024 ** 3;

check(
  "recommends qwen-coder-1.5b for a 4GB machine",
  recommendModel({ totalRamBytes: 4 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-1.5b"
);
check(
  "recommends qwen-coder-1.5b just under the medium threshold (7.9GB)",
  recommendModel({ totalRamBytes: 7.9 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-1.5b"
);
check(
  "recommends qwen-coder-3b at exactly 8GB",
  recommendModel({ totalRamBytes: 8 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-3b"
);
check(
  "recommends qwen-coder-3b for a 12GB machine",
  recommendModel({ totalRamBytes: 12 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-3b"
);
check(
  "recommends qwen-coder-7b at exactly 16GB",
  recommendModel({ totalRamBytes: 16 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-7b"
);
check(
  "recommends qwen-coder-7b for a 32GB machine",
  recommendModel({ totalRamBytes: 32 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-7b"
);

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
