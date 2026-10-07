import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { ReportStore } from "./store.js";
import { WindService } from "./service.js";
import { startServer } from "./api.js";
import { ForwardResult, InverseResult } from "./core.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = process.env.WIND_DB ?? path.join(DATA_DIR, "wind-triangle.db");

function fmt(n: number | null | undefined, digits = 6): string {
  if (n === null || n === undefined) return "-";
  return Number(n.toFixed(digits)).toString();
}

function printForward(r: ForwardResult): void {
  console.log(`模式: 正算 (${r.kind === "stationary" ? "静止" : "移动"})  单位: ${r.unit.speed}/${r.unit.distance}/${r.unit.time}`);
  console.log(`输入: TAS=${fmt(r.input.tas)} 航向=${fmt(r.input.heading)} 风=${fmt(r.input.windSpeed)}kt 自 ${fmt(r.input.windFrom)}`);
  console.log("分量 (东, 北):");
  console.log(`  空速向量: (${fmt(r.airVector.east)}, ${fmt(r.airVector.north)})`);
  console.log(`  风向量  : (${fmt(r.windVector.east)}, ${fmt(r.windVector.north)})`);
  console.log(`  地速向量: (${fmt(r.groundVector.east)}, ${fmt(r.groundVector.north)})`);
  console.log(`地速: ${fmt(r.groundSpeed)} ${r.unit.speed}  航迹: ${r.track === null ? "未定义(静止)" : fmt(r.track)}`);
  if (r.legTime !== null) console.log(`航段时间: ${fmt(r.legTime)} ${r.unit.time}`);
}

function printInverse(r: InverseResult): void {
  const kindLabel = { no_solution: "无解", unique: "唯一解", two_solutions: "两解" }[r.kind];
  console.log(`模式: 反算 (${kindLabel})  单位: ${r.unit.speed}/${r.unit.distance}/${r.unit.time}`);
  console.log(`输入: TAS=${fmt(r.input.tas)} 目标航迹=${fmt(r.input.track)} 风=${fmt(r.input.windSpeed)}kt 自 ${fmt(r.input.windFrom)}`);
  console.log(`风分解: 沿航迹 w_parallel=${fmt(r.windDecomposition.wParallel)}  右侧 w_cross=${fmt(r.windDecomposition.wCross)}`);
  if (r.candidates.length === 0) {
    console.log("无可行候选（侧风超限或地速非正）。");
    return;
  }
  console.log("候选（按地速降序）:");
  console.log("  分支    航向          修正角        地速          横向残差       沿向投影       航段时间");
  for (const c of r.candidates) {
    console.log(
      `  ${c.branch.padEnd(6)}${fmt(c.heading).padEnd(14)}${fmt(c.correction).padEnd(14)}${fmt(c.groundSpeed).padEnd(14)}${fmt(c.verification.crossResidual, 9).padEnd(15)}${fmt(c.verification.alongProjection).padEnd(15)}${fmt(c.legTime)}`
    );
  }
}

function num(args: Record<string, string>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`参数 --${key} 不是有限数值: ${v}`);
    process.exit(2);
  }
  return n;
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function showResponse(out: { ok: boolean; reportId?: number; reused?: boolean; result?: unknown; error?: unknown }): void {
  if (!out.ok) {
    console.error("错误:", JSON.stringify(out.error));
    process.exitCode = 1;
    return;
  }
  console.log(`报告 #${out.reportId}${out.reused ? " (重复请求，返回原结果)" : ""}`);
  const result = out.result as ForwardResult & InverseResult;
  if ("candidates" in result) printInverse(result);
  else printForward(result);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseFlags(rest);
  const service = new WindService(new ReportStore(DB_PATH));

  switch (cmd) {
    case "serve": {
      const port = args.port ? Number(args.port) : 0;
      const started = await startServer(service, port);
      console.log(`API 服务已启动: http://localhost:${started.port} (数据库: ${DB_PATH})`);
      break;
    }
    case "forward": {
      showResponse(
        service.runForward({
          tas: num(args, "tas") as number,
          heading: num(args, "heading") as number,
          windSpeed: num(args, "wind-speed") ?? 0,
          windFrom: num(args, "wind-from") ?? 0,
          distance: num(args, "distance"),
        })
      );
      break;
    }
    case "inverse": {
      showResponse(
        service.runInverse({
          tas: num(args, "tas") as number,
          track: num(args, "track") as number,
          windSpeed: num(args, "wind-speed") ?? 0,
          windFrom: num(args, "wind-from") ?? 0,
          distance: num(args, "distance"),
        })
      );
      break;
    }
    case "batch": {
      const file = args.file;
      if (!file) {
        console.error("用法: cli batch --file cases.json");
        process.exit(2);
      }
      const cases = JSON.parse(readFileSync(file, "utf-8")) as unknown[];
      const out = service.runBatch(cases);
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "explain": {
      const out = service.explain(Number(args.id));
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "report": {
      const out = service.getReport(Number(args.id));
      console.log(JSON.stringify(out.ok ? out.result : out, null, 2));
      break;
    }
    case "reports": {
      console.log(JSON.stringify(service.store.list(50), null, 2));
      break;
    }
    case "export": {
      const format = args.format === "csv" ? "csv" : "json";
      const out = service.exportReport(Number(args.id), format);
      if (!out.ok) {
        console.error("错误:", JSON.stringify(out.error));
        process.exitCode = 1;
        break;
      }
      if (args.out) {
        writeFileSync(args.out, out.content, "utf-8");
        console.log(`已导出到 ${args.out}`);
      } else {
        process.stdout.write(out.content + "\n");
      }
      break;
    }
    case "demo": {
      console.log("== 演示 1: TAS=100 向北，东风 60（风自东来）==");
      showResponse(service.runForward({ tas: 100, heading: 0, windSpeed: 60, windFrom: 90 }));
      console.log("\n== 演示 2: 目标航迹正北，同上的风，反算航向 ==");
      showResponse(service.runInverse({ tas: 100, track: 0, windSpeed: 60, windFrom: 90 }));
      console.log("\n== 演示 3: 顺风 150（风自南来）、TAS=100，目标航迹正北（两解）==");
      showResponse(service.runInverse({ tas: 100, track: 0, windSpeed: 150, windFrom: 180 }));
      break;
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令> [参数]
命令:
  serve [--port N]                      启动 API（省略端口时自动选空闲端口）
  forward --tas V --heading D [--wind-speed V --wind-from D] [--distance L]
  inverse --tas V --track D  [--wind-speed V --wind-from D] [--distance L]
  batch --file cases.json               批量工况（上限 100，失败项独立报告）
  explain --id N                        查看报告分量解释
  report --id N                         查看冻结报告
  reports                               列出最近报告
  export --id N [--format json|csv] [--out 文件]
  demo                                  运行内置演示`);
  }
  if (cmd !== "serve") service.store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
