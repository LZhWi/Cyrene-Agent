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
exports.WorldbookManager = exports.QuadraticResistanceDecay = exports.DefaultRewardStrategy = exports.DEFAULT_DMAE_PARAMS = void 0;
exports.deriveState = deriveState;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const worldbook_constants_1 = require("./worldbook-constants");
const logger_1 = require("../logger");
exports.DEFAULT_DMAE_PARAMS = {
    maxScore: 100,
    promptThreshold: 30,
    userRewardBase: 20,
    wakeGamma: 0.5,
    modelRewardBase: 8,
    wakeLambda: 0.3,
    decayAlpha: 1.5,
    decayBeta: 0.3,
};
// ── v4.0 默认 Reward 策略 ──
// Ru = Bu × (1 + γ · ln(1 + U_old))     [v4.0 §4]
//   - 连续命中 → 至少 Bu
//   - 沉默越久 → ln(1+U) 越大 → 久别重逢奖励越猛
//   - ln 单调递增 + 增长变缓 → 永远不会暴涨（避免无限分）
//
// Rm = Bm × e^(−λ · U_old)             [v4.0 §5]
//   - U_old=0 → 最大 Bm
//   - U_old 越大 → 指数衰减 → 模型话语权越小
//   - Active gating 由主循环控制（v4.0 §5 要求 "当前 Activation ≥ PromptThreshold"）
//   - Rm<D clamp 由主循环控制（v4.0 §8/§9 不变量）
class DefaultRewardStrategy {
    userReward(ctx) {
        const { snap, params } = ctx;
        return params.userRewardBase * (1 + params.wakeGamma * Math.log(1 + snap.userSilence));
    }
    modelReward(ctx) {
        const { snap, params } = ctx;
        return params.modelRewardBase * Math.exp(-params.wakeLambda * snap.userSilence);
    }
}
exports.DefaultRewardStrategy = DefaultRewardStrategy;
// I 不参与（避免高价值条目既涨得快又忘得慢而天然霸榜）。
// ── v3.4 默认 Decay 策略 ──
// Decay = (α·US² + β·MS²) / sqrt(I)   [I 仅在 Resistance：高 I = 抵抗强 = 忘得慢]
// 平方 → 累计加速遗忘 §8.1；除以 sqrt(I) → "价值决定忘得多慢，而不是爱得多深"。
class QuadraticResistanceDecay {
    compute(ctx) {
        const { entry, snap, params } = ctx;
        const I = Math.max(worldbook_constants_1.WORLDBOOK_CONSTANTS.MIN_INTRINSIC_VALUE, entry.intrinsicValue);
        const resistance = 1 / Math.sqrt(I);
        const raw = params.decayAlpha * snap.userSilence * snap.userSilence
            + params.decayBeta * snap.modelSilence * snap.modelSilence;
        return raw * resistance;
    }
}
exports.QuadraticResistanceDecay = QuadraticResistanceDecay;
// ── 状态派生（纯函数，业务层 + 策略层共用）──
// <=0 → Archived；>= threshold → Active；之间 → Dormant
function deriveState(activation, threshold) {
    if (activation <= 0)
        return "Archived";
    if (activation >= threshold)
        return "Active";
    return "Dormant";
}
class WorldbookManager {
    entries = [];
    worldbookDir;
    state = new Map();
    // ── One-Shot cascade：本轮用户命中后连带触发的条目（不入 DMAE 状态表，只本轮有效）──
    lastCascadeEntries = [];
    params;
    rewardStrategy;
    decayStrategy;
    stateFile;
    debug;
    // 终态注入上限（详见 worldbook-constants.ts）
    static MAX_ACTIVE = worldbook_constants_1.WORLDBOOK_CONSTANTS.MAX_ACTIVE;
    // .md 未写 intrinsic value 时的 fallback（详见 worldbook-constants.ts）
    static DEFAULT_INTRINSIC_VALUE = worldbook_constants_1.WORLDBOOK_CONSTANTS.DEFAULT_INTRINSIC_VALUE;
    constructor(worldbookDir, options) {
        this.worldbookDir = worldbookDir;
        this.params = { ...exports.DEFAULT_DMAE_PARAMS, ...(options?.params ?? {}) };
        this.rewardStrategy = options?.rewardStrategy ?? new DefaultRewardStrategy();
        this.decayStrategy = options?.decayStrategy ?? new QuadraticResistanceDecay();
        this.stateFile = options?.stateFile;
        this.debug = options?.debug ?? true;
    }
    // Load all .md files from the worldbook directory
    async loadFromDirectory() {
        if (!fs.existsSync(this.worldbookDir)) {
            console.warn("[Worldbook] directory not found:", this.worldbookDir);
            return;
        }
        const files = fs.readdirSync(this.worldbookDir).filter((f) => f.endsWith(".md"));
        if (files.length === 0) {
            console.warn("[Worldbook] no .md files found in:", this.worldbookDir);
            return;
        }
        const allEntries = [];
        for (const file of files) {
            const filePath = path.join(this.worldbookDir, file);
            const content = fs.readFileSync(filePath, "utf8");
            const entries = this.parseMarkdown(content, file);
            allEntries.push(...entries);
        }
        this.entries = allEntries;
        // 初始化 DMAE 状态：每条非常驻条目 activation=0（Archived 冷态）
        // 常驻条目不进 DMAE（始终注入），不给它们分配状态。
        this.state.clear();
        for (const e of this.entries) {
            if (e.enabled && !e.permanent) {
                this.state.set(e.id, { activation: 0, userSilence: 0, modelSilence: 0 });
            }
        }
        // v1 持久化 seam：预留，暂为空（重启回 0）
        this.loadState();
        logger_1.logger.info(logger_1.LogTag.Worldbook, `loaded ${allEntries.length} entries from ${files.length} files; DMAE state initialized for ${this.state.size} non-permanent entries`);
    }
    // 从内存 entries 加载（不读 fs）：simulator / 测试用。
    // 复用 loadFromDirectory 的状态初始化逻辑，保证 sim 和生产用同一套初始化路径。
    loadFromEntries(entries) {
        this.entries = entries;
        this.state.clear();
        for (const e of this.entries) {
            if (e.enabled && !e.permanent) {
                this.state.set(e.id, { activation: 0, userSilence: 0, modelSilence: 0 });
            }
        }
        this.loadState();
    }
    // Parse markdown format:
    // ## 条目名
    // - 触发词: 词1, 词2, 词3
    // - 常驻: 是
    // - 优先级: 200
    // - 内在价值: 60                ← v3.4 新名（与 初始分/initial_score/intrinsic_value 兼容）
    //
    // 内容段落...
    // ---
    parseMarkdown(content, fileName) {
        const entries = [];
        // Split by ## headings
        const lines = content.split("\n");
        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trim();
            // Find next ## heading
            if (!line.startsWith("## ")) {
                i++;
                continue;
            }
            const title = line.replace(/^## /, "").trim();
            i++;
            // Parse metadata lines (lines starting with -)
            let keywords = [];
            let priority = 5;
            let permanent = false;
            let intrinsicValue = WorldbookManager.DEFAULT_INTRINSIC_VALUE;
            let linkTriggers = [];
            let contentStart = i;
            while (i < lines.length) {
                const metaLine = lines[i].trim();
                if (metaLine.startsWith("- 触发词:") || metaLine.startsWith("- 触发词：")) {
                    const val = metaLine.replace(/^-\s*触发词[：:]/, "").trim();
                    keywords = val.split(/[,，、]/).map((k) => k.trim()).filter(Boolean);
                    i++;
                }
                else if (metaLine.startsWith("- 常驻:")) {
                    const val = metaLine.replace(/^-\s*常驻:/, "").trim();
                    permanent = val === "是" || val === "yes" || val === "true";
                    i++;
                }
                else if (metaLine.startsWith("- 优先级:")) {
                    const val = metaLine.replace(/^-\s*优先级:/, "").trim();
                    priority = parseInt(val) || 5;
                    i++;
                }
                else if (metaLine.startsWith("- 初始分:") || metaLine.startsWith("- 初始分：") ||
                    metaLine.startsWith("- initial_score:") || metaLine.startsWith("- initial_score：") ||
                    metaLine.startsWith("- 内在价值:") || metaLine.startsWith("- 内在价值：") ||
                    metaLine.startsWith("- intrinsic_value:") || metaLine.startsWith("- intrinsic_value：")) {
                    const val = metaLine.replace(/^-\s*(初始分|initial_score|内在价值|intrinsic_value)[：:]/, "").trim();
                    const parsed = parseFloat(val);
                    intrinsicValue = Number.isFinite(parsed) ? parsed : WorldbookManager.DEFAULT_INTRINSIC_VALUE;
                    i++;
                }
                else if (metaLine.startsWith("- 连带触发词:") || metaLine.startsWith("- 连带触发词：") ||
                    metaLine.startsWith("- 连带触发:") || metaLine.startsWith("- 连带触发：") ||
                    metaLine.startsWith("- link_triggers:") || metaLine.startsWith("- link_triggers：")) {
                    const val = metaLine.replace(/^-\s*(连带触发词|连带触发|link_triggers)[：:]/, "").trim();
                    // "无" / "无" / "" 表示不连带
                    if (val && val !== "无" && val !== "无" && val !== "none" && val !== "-") {
                        linkTriggers = val.split(/[,，、]/).map((k) => k.trim()).filter(Boolean);
                    }
                    i++;
                }
                else if (metaLine.startsWith("---")) {
                    // Separator line — stop metadata parsing
                    i++;
                    break;
                }
                else if (metaLine === "" || metaLine.startsWith("# ")) {
                    // Empty line or top-level heading — stop
                    break;
                }
                else if (metaLine.startsWith("- ")) {
                    // Unknown metadata field — skip
                    i++;
                }
                else {
                    // Content line — stop metadata parsing
                    break;
                }
            }
            // Collect content until next ## or ---
            const contentLines = [];
            while (i < lines.length) {
                const cl = lines[i];
                if (cl.trim().startsWith("## ") || cl.trim() === "---") {
                    break;
                }
                contentLines.push(cl);
                i++;
            }
            const entryContent = contentLines.join("\n").trim();
            if (entryContent) {
                entries.push({
                    id: `wb_${fileName.replace(/\.md$/, "")}_${title.replace(/\s+/g, "_")}`,
                    keywords,
                    content: entryContent,
                    priority,
                    permanent,
                    enabled: true,
                    intrinsicValue,
                    linkTriggers,
                });
            }
            // suppress unused-var lint for contentStart (kept for parity with original structure)
            void contentStart;
        }
        return entries;
    }
    // ── DMAE 打分层：每轮更新所有条目的 Activation/US/MS ──
    // v3.4 收口公式：
    //   reward = userHit ? rewardGain × Wake(US_old) × Eff(A_old) : 0   (I 不参与 Reward)
    //   decay  = (α·US_new² + β·MS_new²) / sqrt(I)                       (I 仅在 Resistance)
    //   A_new  = clamp(A_old + reward - decay, 0, MaxScore)
    //   if userHit && A_old 状态 == Archived: A_new = max(A_new, I)      (★ 仅 Archived 复活时 floor；I 参与 Floor 基线)
    // MS 语义：距离最近一次"进入上下文"的轮数（userHit 或 modelHit 都重置），不是"模型有没有说过"
    // ModelHit：只重置 msNew = 0，不给任何 reward（模型没有兴趣表达权 §7.3/§7.4）
    // Snapshot 语义：每条 entry 独立、先读旧值再统一写，互不影响（DMAE §4/§11.1）。
    updateActivation(userText, modelText) {
        const user = userText ?? "";
        const model = modelText ?? "";
        const params = this.params;
        const max = params.maxScore;
        const changed = [];
        // ── 第一遍：收集本轮所有 userHit 条目 id（cascade 通道用，DMAE 主循环也要）──
        const userHitEntryIds = new Set();
        for (const entry of this.entries) {
            if (!entry.enabled || entry.permanent)
                continue;
            if (entry.keywords.length === 0)
                continue;
            if (entry.keywords.some((kw) => user.includes(kw))) {
                userHitEntryIds.add(entry.id);
            }
        }
        for (const entry of this.entries) {
            if (!entry.enabled || entry.permanent)
                continue;
            if (entry.keywords.length === 0)
                continue;
            const st = this.state.get(entry.id);
            if (!st)
                continue;
            // ─ snapshot old ─
            const aOld = st.activation;
            const usOld = st.userSilence;
            const msOld = st.modelSilence;
            // ─ hits ─
            const userHit = entry.keywords.some((kw) => user.includes(kw));
            const modelHit = entry.keywords.some((kw) => model.includes(kw));
            // ─ silence update ─
            const usNew = userHit ? 0 : usOld + 1;
            // MS = 距离最近一次"进入上下文"的轮数。用户主动提 OR 模型自然提都属于"进入上下文"，
            // 所以 userHit 也重置 ms——否则用户连续提但模型不复述时 ms 累积导致 decay 上升、A 反而下降。
            const msNew = (userHit || modelHit) ? 0 : msOld + 1;
            // ─ positive: user reward（仅 userHit，I 不参与） ─
            const userReward = userHit
                ? this.rewardStrategy.userReward({ entry, snap: { activation: aOld, userSilence: usOld, modelSilence: msOld }, params })
                : 0;
            // ─ negative: decay（I 仅在 Resistance） ─
            const decay = this.decayStrategy.compute({
                entry,
                snap: { userSilence: usNew, modelSilence: msNew },
                params,
            });
            // ─ positive: model reward（仅 modelHit + Active gating） ─
            // v4.0 §5：Rm = Bm·e^(-λ·U_old)，仅当 A ≥ PromptThreshold 时给分
            // v4.0 §8 不变量：Rm < D 严格成立，由主循环 clamp 保证（避免 Rm ≥ D 时仍能涨分）
            let modelReward = 0;
            if (modelHit && deriveState(aOld, params.promptThreshold) === worldbook_constants_1.WORLDBOOK_CONSTANTS.STATES.ACTIVE) {
                const rawRm = this.rewardStrategy.modelReward({ entry, snap: { activation: aOld, userSilence: usOld, modelSilence: msOld }, params });
                // 不变量 clamp：Rm = min(Rm, D - ε)
                modelReward = Math.max(0, Math.min(rawRm, decay - worldbook_constants_1.WORLDBOOK_CONSTANTS.EPSILON));
            }
            // ─ commit ─
            let aNew = aOld + userReward + modelReward - decay;
            aNew = Math.max(0, aNew);
            // ★ Floor 仅在 Archived 复活时触发（避免高价值条目每次命中都 floor 让 Decay/Wake 失效）
            if (userHit && deriveState(aOld, params.promptThreshold) === worldbook_constants_1.WORLDBOOK_CONSTANTS.FLOOR_TRIGGER_STATE) {
                aNew = Math.max(aNew, entry.intrinsicValue);
            }
            aNew = Math.min(max, aNew);
            st.activation = aNew;
            st.userSilence = usNew;
            st.modelSilence = msNew;
            if (this.debug && (userHit || modelHit || Math.abs(aNew - aOld) >= 0.05)) {
                const reasons = [];
                if (userHit)
                    reasons.push(`U+${userReward.toFixed(2)}`);
                if (modelHit)
                    reasons.push(`M+${modelReward.toFixed(2)}`);
                if (decay > 0)
                    reasons.push(`D-${decay.toFixed(2)}`);
                if (userHit && deriveState(aOld, params.promptThreshold) === worldbook_constants_1.WORLDBOOK_CONSTANTS.FLOOR_TRIGGER_STATE)
                    reasons.push(`floor→${entry.intrinsicValue}`);
                changed.push({ id: entry.id, aOld, aNew, reason: reasons.join(" ") });
            }
        }
        if (this.debug && changed.length > 0) {
            console.log(`[Worldbook/DMAE] update: ${changed.length} entries changed`);
            for (const c of changed.slice(0, 12)) {
                console.log(`  ${c.id}: ${c.aOld.toFixed(1)} → ${c.aNew.toFixed(1)}  (${c.reason})`);
            }
        }
        // ── One-Shot 联动触发（不入 DMAE 状态表，只本轮有效）──
        // 规则：只有 userHit 的条目才有连带触发权；cascade 目标不再级联（1 层封顶）。
        // 防死循环 3 条硬约束：
        //   1. 1 层封顶：cascade 只从 userHit 触发，cascade 目标不会再 cascade
        //   2. userHit 拦截：cascade 目标已在 userHit 列表则跳过（已被主动激活）
        //   3. cascade 集合去重：同条目本轮只 cascade 一次
        this.lastCascadeEntries = [];
        const cascadeInjected = new Set();
        for (const entry of this.entries) {
            if (!userHitEntryIds.has(entry.id))
                continue;
            if (entry.linkTriggers.length === 0)
                continue;
            if (entry.permanent || !entry.enabled)
                continue;
            // 找 linkTriggers 对应的子条目（关键词命中）
            const targets = this.entries.filter(e => e.enabled && !e.permanent &&
                e.keywords.some(kw => entry.linkTriggers.includes(kw)));
            for (const target of targets) {
                // 硬约束 2：跳过 userHit
                if (userHitEntryIds.has(target.id))
                    continue;
                // 硬约束 3：cascade 去重
                if (cascadeInjected.has(target.id))
                    continue;
                cascadeInjected.add(target.id);
                this.lastCascadeEntries.push(target);
            }
        }
        if (this.debug && this.lastCascadeEntries.length > 0) {
            console.log(`[Worldbook/Cascade] ${this.lastCascadeEntries.length} entries one-shot injected: ${this.lastCascadeEntries.map(e => e.id).join(", ")}`);
        }
    }
    // 取本轮 One-Shot cascade 触发的条目（仅供 orchestrator 注入用，不进 DMAE 状态表）
    getCascadeEntries() {
        return [...this.lastCascadeEntries];
    }
    // ── 业务层：阈值门控 + 注入 ──
    // deriveState(activation, promptThreshold)=="Active" 的条目注入；按 activation 降序、priority 降序 tiebreak、截 MAX_ACTIVE。
    getActiveEntries(promptThreshold) {
        const th = promptThreshold ?? this.params.promptThreshold;
        const active = this.entries
            .filter((e) => {
            if (!e.enabled || e.permanent)
                return false;
            const st = this.state.get(e.id);
            if (!st)
                return false;
            return deriveState(st.activation, th) === worldbook_constants_1.WORLDBOOK_CONSTANTS.STATES.ACTIVE;
        })
            .sort((a, b) => {
            const sa = this.state.get(a.id).activation;
            const sb = this.state.get(b.id).activation;
            if (sb !== sa)
                return sb - sa;
            return b.priority - a.priority;
        })
            .slice(0, WorldbookManager.MAX_ACTIVE);
        if (this.debug && active.length > 0) {
            console.log(`[Worldbook/DMAE] active entries injected: ${active.length} (threshold=${th})`);
        }
        // 返回带条目标题的完整内容（模型需要知道这段设定在说谁）
        return active.map((e) => {
            // 从 entry.id 还原可读标题：wb_<file>_<title> → <title>
            const title = e.id.replace(/^wb_[^_]+_/, "").replace(/_/g, " ");
            return `【${title}】\n${e.content}`;
        });
    }
    // Get permanent entries (常驻) — always included, bypass DMAE
    getPermanentEntries() {
        return this.entries
            .filter((e) => e.enabled && e.permanent)
            .sort((a, b) => b.priority - a.priority)
            .map((e) => e.content);
    }
    // Get all registered trigger words (legacy, kept for compatibility)
    getAllTriggerWords() {
        const words = new Set();
        for (const entry of this.entries) {
            for (const kw of entry.keywords) {
                words.add(kw);
            }
        }
        return [...words];
    }
    get entriesCount() {
        return this.entries.length;
    }
    // ── 只读访问器（simulator / 调试用）──
    getEntries() {
        return this.entries;
    }
    getState(id) {
        return this.state.get(id);
    }
    // ── 持久化 seam（v1 no-op；后续接 JsonVectorStore 同款 sync JSON）──
    loadState() {
        if (!this.stateFile)
            return;
        // TODO v1.1: fs.readFileSync(this.stateFile) → 反序列化到 this.state
        // 暂不落盘，重启回 0（已确认 v1 接受）
    }
    saveState() {
        if (!this.stateFile)
            return;
        // TODO v1.1: fs.writeFileSync(this.stateFile, JSON.stringify([...this.state]))
    }
}
exports.WorldbookManager = WorldbookManager;
