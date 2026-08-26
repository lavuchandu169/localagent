import { recommendModelSize } from "../electron/hardwareInfo.js";

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
  "recommends small for a 4GB machine",
  recommendModelSize({ totalRamBytes: 4 * GB, gpu: false, vramBytes: 0 }) === "small"
);
check(
  "recommends small just under the medium threshold (7.9GB)",
  recommendModelSize({ totalRamBytes: 7.9 * GB, gpu: false, vramBytes: 0 }) === "small"
);
check(
  "recommends medium at exactly 8GB",
  recommendModelSize({ totalRamBytes: 8 * GB, gpu: false, vramBytes: 0 }) === "medium"
);
check(
  "recommends medium for a 12GB machine",
  recommendModelSize({ totalRamBytes: 12 * GB, gpu: false, vramBytes: 0 }) === "medium"
);
check(
  "recommends large at exactly 16GB",
  recommendModelSize({ totalRamBytes: 16 * GB, gpu: false, vramBytes: 0 }) === "large"
);
check(
  "recommends large for a 32GB machine",
  recommendModelSize({ totalRamBytes: 32 * GB, gpu: false, vramBytes: 0 }) === "large"
);

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
