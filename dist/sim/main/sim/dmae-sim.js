"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// ── DMAE Simulator 入口 ──
// 直接 import 真 worldbook.ts，不 mock，不重写算法。
// 改一个参数 → 重跑 → 看曲线/统计 → 改回/保留
const path = __importStar(require("path"));
const worldbook_1 = require("../rag/worldbook");
const coffee_lifecycle_1 = require("./scenarios/coffee-lifecycle");
const four_tier_mix_1 = require("./scenarios/four-tier-mix");
const dormant_rescue_1 = require("./scenarios/dormant-rescue");
const stats_1 = require("./render/stats");
const csv_export_1 = require("./render/csv-export");
const ascii_line_chart_1 = require("./render/ascii-line-chart");
const ascii_bars_1 = require("./render/ascii-bars");
function parseArgs(argv) {
    const args = {
        scenario: "coffee",
        paramOverrides: {},
        rewardGainSweep: null,
        outputDir: path.join(process.cwd(), "sim-result", "v3.4"),
        showCharts: true,
        showBars: true,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        // 兼容 --key=value 和 --key value 两种形态
        const eq = a.includes("=");
        const key = eq ? a.split("=")[0] : a;
        const valFromEq = eq ? a.split("=").slice(1).join("=") : null;
        const next = () => argv[++i];
        const v = () => valFromEq ?? next();
        if (key === "--scenario")
            args.scenario = v();
        else if (key === "--userRewardBase") {
            const x = v();
            if (x.includes(",")) {
                args.rewardGainSweep = x.split(",").map(Number).filter(Number.isFinite);
            }
            else {
                args.paramOverrides.userRewardBase = Number(x);
            }
        }
        else if (key === "--wakeGamma")
            args.paramOverrides.wakeGamma = Number(v());
        else if (key === "--modelRewardBase")
            args.paramOverrides.modelRewardBase = Number(v());
        else if (key === "--wakeLambda")
            args.paramOverrides.wakeLambda = Number(v());
        else if (key === "--alpha")
            args.paramOverrides.decayAlpha = Number(v());
        else if (key === "--beta")
            args.paramOverrides.decayBeta = Number(v());
        else if (key === "--threshold")
            args.paramOverrides.promptThreshold = Number(v());
        else if (key === "--outputDir")
            args.outputDir = v();
        else if (key === "--no-charts")
            args.showCharts = false;
        else if (key === "--no-bars")
            args.showBars = false;
    }
    return args;
}
function getScenario(name) {
    if (name === "coffee")
        return coffee_lifecycle_1.coffeeLifecycle;
    if (name === "mix")
        return four_tier_mix_1.fourTierMix;
    if (name === "rescue")
        return dormant_rescue_1.dormantRescue;
    throw new Error(`Unknown scenario: ${name}`);
}
function runScenario(scenario, params, debug = false) {
    // 直接用真 WorldbookManager：通过公开的 loadFromEntries 注入 entries（不反射、不破坏封装）
    const mgr = new worldbook_1.WorldbookManager("", { params, debug: false });
    mgr.loadFromEntries(scenario.buildEntries());
    const rounds = scenario.buildRounds();
    const entries = mgr.getEntries();
    const snapshots = [];
    for (let turn = 0; turn < rounds.length; turn++) {
        const round = rounds[turn];
        // 跑一整轮：manager.updateActivation(userText, modelText, turn)
        mgr.updateActivation(round.userText, round.modelText, turn);
        // 拍快照
        const snap = entries.map((e) => {
            const st = mgr.getState(e.id);
            const a = st?.activation ?? 0;
            const us = st?.userSilence ?? 0;
            const ms = st?.modelSilence ?? 0;
            const recentUserHits = st?.recentUserHits ?? [];
            return {
                entryId: e.id,
                intrinsicValue: e.intrinsicValue,
                priority: e.priority,
                activation: a,
                userSilence: us,
                modelSilence: ms,
                state: (0, worldbook_1.deriveState)(a, params.promptThreshold),
                userHit: e.keywords.some((kw) => round.userText.includes(kw)),
                modelHit: e.keywords.some((kw) => round.modelText.includes(kw)),
                recentUserHits,
            };
        });
        snapshots.push(snap);
    }
    const result = {
        scenario: scenario.name,
        params,
        entries: [...entries],
        rounds,
        snapshots,
        stats: { promptOccupancy: new Map(), avgActiveLife: new Map(), promptRanking: new Map(), totalRounds: rounds.length },
    };
    result.stats = (0, stats_1.computeStats)(result);
    return result;
}
function runSweep(scenario, baseParams, values) {
    console.log(`\n=== Parameter Sweep: userRewardBase = [${values.join(", ")}] on ${scenario.name} ===\n`);
    console.log("Bu       |  I=90 占用%  |  I=70 占用%  |  I=45 占用%  |  I=15 占用%  |  avgLife(I=45)");
    console.log("---------|---------------|---------------|---------------|---------------|---------------");
    for (const v of values) {
        const params = { ...baseParams, userRewardBase: v };
        const result = runScenario(scenario, params, false);
        const tiers = [90, 70, 45, 15];
        const occByI = [];
        for (const I of tiers) {
            const ent = result.entries.find((e) => Math.abs(e.intrinsicValue - I) < 1 && !e.permanent);
            const occ = ent ? (result.stats.promptOccupancy.get(ent.id) ?? 0) * 100 : 0;
            occByI.push(occ.toFixed(1).padStart(5));
        }
        const midEnt = result.entries.find((e) => Math.abs(e.intrinsicValue - 45) < 1 && !e.permanent);
        const midLife = midEnt ? (result.stats.avgActiveLife.get(midEnt.id) ?? 0).toFixed(2) : "-";
        console.log(`${String(v).padStart(7)}  |  ${occByI[0]}        |  ${occByI[1]}        |  ${occByI[2]}        |  ${occByI[3]}        |  ${midLife}`);
    }
}
function main() {
    const cli = parseArgs(process.argv.slice(2));
    const scenario = getScenario(cli.scenario);
    console.log(`\n========================================`);
    console.log(`  DMAE v3.4 Simulator`);
    console.log(`  Scenario: ${scenario.name}`);
    console.log(`  ${scenario.description}`);
    console.log(`========================================`);
    if (cli.rewardGainSweep) {
        runSweep(scenario, { ...worldbook_1.DEFAULT_DMAE_PARAMS, ...cli.paramOverrides }, cli.rewardGainSweep);
        return;
    }
    const params = { ...worldbook_1.DEFAULT_DMAE_PARAMS, ...cli.paramOverrides };
    console.log(`参数: ${JSON.stringify(params, null, 2)}`);
    const result = runScenario(scenario, params, true);
    // CSV
    const csvFile = (0, csv_export_1.exportCsv)(result, cli.outputDir);
    console.log(`\nCSV 写入: ${csvFile}`);
    // 统计
    (0, stats_1.printStats)(result);
    // 折线图
    if (cli.showCharts)
        (0, ascii_line_chart_1.renderLineCharts)(result);
    // 条形图
    if (cli.showBars)
        (0, ascii_bars_1.renderBars)(result);
}
main();
