// 命令行接口：正算 / 反算 / 批量 / 解释 / 报告查询 / 导出。
// 用法：
//   node dist/src/cli.js forward --tas 100 --heading 0 --wind-speed 60 --wind-from 90 [--distance 120]
//   node dist/src/cli.js inverse --tas 100 --track 0 --wind-speed 60 --wind-from 90 [--distance 120]
//   node dist/src/cli.js batch cases.json
//   node dist/src/cli.js explain
//   node dist/src/cli.js reports [--limit 20]
//   node dist/src/cli.js export <id> [--format json|csv]

import * as fs from "node:fs";
import { forward, inverse, ForwardResult, InverseResult } from "./core";
import { saveReport, getReport, listReports } from "./db";
import { EXPLANATION } from "./explain";
import { BATCH_LIMIT } from "./server";

function parseArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function num(flags: Record<string, string>, ...names: string[]): number | undefined {
  for (const n of names) {
    if (flags[n] !== undefined) {
      const v = Number(flags[n]);
      return v;
    }
  }
  return undefined;
}

function fmt(x: number | null | undefined, digits = 8): string {
  if (x === null || x === undefined) return "未定义";
  return Number(x.toFixed(digits)).toString();
}

function printForward(r: ForwardResult): void {
  console.log(`状态: ${r.status === "stationary" ? "静止（地速≈0，航迹未定义）" : "正常"}`);
  console.log("分量表 (东, 北):");
  console.log(`  空速向量: (${fmt(r.airVector.east)}, ${fmt(r.airVector.north)})`);
  console.log(`  风向量  : (${fmt(r.windVector.east)}, ${fmt(r.windVector.north)})`);
  console.log(`  地速向量: (${fmt(r.groundVector.east)}, ${fmt(r.groundVector.north)})`);
  console.log(`地速大小: ${fmt(r.groundSpeed)} ${r.units.speed}`);
  console.log(`地面航迹: ${fmt(r.groundTrack)} 度`);
  if (r.legTimeHours !== null) console.log(`航段时间: ${fmt(r.legTimeHours)} 小时`);
}

function printInverse(r: InverseResult): void {
  const statusText =
    r.status === "no-solution" ? "无解" : r.status === "one-solution" ? "唯一解" : "两解";
  console.log(`状态: ${statusText}`);
  console.log(`风沿航迹分量: ${fmt(r.windAlongTrack)}，右侧分量: ${fmt(r.windCrossTrack)} ${r.units.speed}`);
  if (r.candidates.length > 0) {
    console.log("候选表（按地速从大到小）:");
    console.log("  分支 | 航向(度)      | 修正角(度)    | 地速         | 横向残差   | 纵向投影");
    for (const c of r.candidates) {
      console.log(
        `   ${c.branch}   | ${fmt(c.trueHeading).padEnd(13)} | ${fmt(c.correctionAngle).padEnd(13)} | ${fmt(c.groundSpeed).padEnd(12)} | ${fmt(c.crossTrackResidual, 12).padEnd(10)} | ${fmt(c.alongTrackProjection)}`
      );
      if (c.legTimeHours !== null) console.log(`       | 航段时间: ${fmt(c.legTimeHours)} 小时`);
    }
  }
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  switch (cmd) {
    case "forward": {
      const result = forward({
        tas: num(flags, "tas") as number,
        trueHeading: num(flags, "heading", "true-heading") as number,
        windSpeed: num(flags, "wind-speed") as number,
        windFrom: num(flags, "wind-from") as number,
        distance: num(flags, "distance"),
      });
      const report = saveReport("forward", flags, result.input, result.units, result.toleranceVersion, result);
      printForward(result);
      console.log(`报告 #${report.id}${report.replayed ? "（重复请求，返回原结果）" : ""} 已保存`);
      break;
    }
    case "inverse": {
      const result = inverse({
        tas: num(flags, "tas") as number,
        desiredTrack: num(flags, "track", "desired-track") as number,
        windSpeed: num(flags, "wind-speed") as number,
        windFrom: num(flags, "wind-from") as number,
        distance: num(flags, "distance"),
      });
      const report = saveReport("inverse", flags, result.input, result.units, result.toleranceVersion, result);
      printInverse(result);
      console.log(`报告 #${report.id}${report.replayed ? "（重复请求，返回原结果）" : ""} 已保存`);
      break;
    }
    case "batch": {
      const file = positional[0];
      if (!file) throw new Error("用法: cli batch <cases.json>");
      const cases = JSON.parse(fs.readFileSync(file, "utf-8")) as Array<{ mode: "forward" | "inverse"; input: never }>;
      if (!Array.isArray(cases)) throw new Error("批量文件必须是数组");
      if (cases.length > BATCH_LIMIT) throw new Error(`批量上限 ${BATCH_LIMIT}，收到 ${cases.length}`);
      cases.forEach((c, i) => {
        try {
          const result = c.mode === "forward" ? forward(c.input) : inverse(c.input);
          const report = saveReport(c.mode, c.input, result.input, result.units, result.toleranceVersion, result);
          console.log(`#${i} [${c.mode}] 状态=${result.status} 报告#${report.id}`);
          if (result.kind === "forward") printForward(result as ForwardResult);
          else printInverse(result as InverseResult);
        } catch (e) {
          console.log(`#${i} [${c.mode}] 失败: ${(e as Error).message}（不影响其他工况）`);
        }
        console.log("---");
      });
      break;
    }
    case "explain":
      console.log(EXPLANATION);
      break;
    case "reports": {
      const limit = Number(flags.limit ?? 20);
      for (const r of listReports(limit)) {
        console.log(`#${r.id} [${r.mode}] ${r.createdAt} 状态=${(r.result as { status: string }).status} 容差=${r.toleranceVersion}`);
      }
      break;
    }
    case "export": {
      const id = Number(positional[0]);
      const report = getReport(id);
      if (!report) throw new Error(`报告 ${id} 不存在`);
      const format = flags.format ?? "json";
      if (format === "csv") {
        const { id: rid } = report;
        // 复用 server 的 CSV 逻辑等价实现
        const result = report.result as ForwardResult | InverseResult;
        const lines: string[] = [`report_id,${rid}`, `mode,${report.mode}`, `status,${result.status}`, ""];
        if (result.kind === "forward") {
          lines.push("component,east,north");
          lines.push(`air,${result.airVector.east},${result.airVector.north}`);
          lines.push(`wind,${result.windVector.east},${result.windVector.north}`);
          lines.push(`ground,${result.groundVector.east},${result.groundVector.north}`);
        } else {
          lines.push("branch,true_heading,correction_angle,ground_speed,cross_residual,along_projection");
          for (const c of result.candidates) {
            lines.push(`${c.branch},${c.trueHeading},${c.correctionAngle},${c.groundSpeed},${c.crossTrackResidual},${c.alongTrackProjection}`);
          }
        }
        console.log(lines.join("\n"));
      } else {
        console.log(JSON.stringify(report, null, 2));
      }
      break;
    }
    default:
      console.log("命令: forward | inverse | batch <file> | explain | reports | export <id>");
      process.exitCode = cmd ? 1 : 0;
  }
}

try {
  main();
} catch (e) {
  const err = e as { code?: string; message?: string };
  console.error(`错误${err.code ? ` [${err.code}]` : ""}: ${err.message}`);
  process.exitCode = 1;
}
