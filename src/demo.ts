// 演示脚本：运行两个教学示例，输出保存在项目内 data/demo/。

import * as fs from "node:fs";
import * as path from "node:path";
import { forward, inverse } from "./core";
import { DATA_DIR } from "./db";

const outDir = path.join(DATA_DIR, "demo");
fs.mkdirSync(outDir, { recursive: true });

// 示例 1：真空速 100 向北，东风 60（风从东来，吹向西）。
// 正向：地速向量 = (东 -60, 北 100)。
const demo1Forward = forward({ tas: 100, trueHeading: 0, windSpeed: 60, windFrom: 90 });
// 反算：目标航迹正北 → 航向 ≈ 36.86989765°，地速 80。
const demo1Inverse = inverse({ tas: 100, desiredTrack: 0, windSpeed: 60, windFrom: 90 });

// 示例 2：向北顺风 150（南风，windFrom=180），空速 100，目标航迹正北 → 两解。
// 朝北飞地速 250；朝南飞也被风吹向北，地速 50。
const demo2 = inverse({ tas: 100, desiredTrack: 0, windSpeed: 150, windFrom: 180 });

const all = { demo1Forward, demo1Inverse, demo2 };
const file = path.join(outDir, "demo-results.json");
fs.writeFileSync(file, JSON.stringify(all, null, 2), "utf-8");

console.log("示例1 正向（tas=100 航向0，东风60）:");
console.log(`  地速向量: 东=${demo1Forward.groundVector.east}, 北=${demo1Forward.groundVector.north}`);
console.log("示例1 反算（目标航迹正北）:");
for (const c of demo1Inverse.candidates) {
  console.log(`  分支${c.branch} 航向=${c.trueHeading.toFixed(8)}° 地速=${c.groundSpeed.toFixed(6)}`);
}
console.log("示例2 反算（顺风150 空速100 目标正北，两解）:");
for (const c of demo2.candidates) {
  console.log(`  分支${c.branch} 航向=${c.trueHeading.toFixed(6)}° 地速=${c.groundSpeed.toFixed(6)}`);
}
console.log(`结果已写入 ${file}`);
