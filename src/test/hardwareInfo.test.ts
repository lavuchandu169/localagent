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
  "recommends qwen-coder-1.5b comfortably below the medium threshold's tolerance (7GB)",
  recommendModel({ totalRamBytes: 7 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-1.5b"
);
check(
  "recommends qwen-coder-3b at exactly 8GB",
  recommendModel({ totalRamBytes: 8 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-3b"
);
check(
  // Correctness finding (code-review-and-quality pass): a real machine
  // marketed/advertised as "8GB" commonly reports a totalRamBytes a bit
  // under the exact 8 * 1024³ (firmware/integrated-GPU/kernel
  // reservations carved out before the OS ever reports a total) —
  // comparing against the round number exactly silently misclassified
  // the real 8GB machine this number is meant to describe.
  "recommends qwen-coder-3b for a real-world 8GB machine reporting slightly under 8GB (7.5GB)",
  recommendModel({ totalRamBytes: 7.5 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-3b"
);
check(
  "recommends qwen-coder-3b for a 12GB machine",
  recommendModel({ totalRamBytes: 12 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-3b"
);
check(
  "recommends qwen-coder-3b comfortably below the high threshold's tolerance (15GB)",
  recommendModel({ totalRamBytes: 15 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-3b"
);
check(
  "recommends qwen-coder-7b at exactly 16GB",
  recommendModel({ totalRamBytes: 16 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-7b"
);
check(
  "recommends qwen-coder-7b for a real-world 16GB machine reporting slightly under 16GB (15.5GB)",
  recommendModel({ totalRamBytes: 15.5 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-7b"
);
check(
  "recommends qwen-coder-7b for a 32GB machine",
  recommendModel({ totalRamBytes: 32 * GB, gpu: false, vramBytes: 0 }) === "qwen-coder-7b"
);

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
