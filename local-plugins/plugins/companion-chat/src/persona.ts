import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const PERSONA_STYLE_IDS = [
  "01_default",
  "02_lively",
  "03_healing",
  "04_focused",
  "05_sweet",
] as const;

export type PersonaStyleId = typeof PERSONA_STYLE_IDS[number];

const STYLE_FILES: Record<PersonaStyleId, string> = {
  "01_default": "01_default.md",
  "02_lively": "02_lively.md",
  "03_healing": "03_healing.md",
  "04_focused": "04_focused.md",
  "05_sweet": "05_sweet.md",
};

const SEPARATOR = "\n\n---\n\n";

function replaceRequired(content: string, from: string, to: string): string {
  if (!content.includes(from)) throw new Error(`内置人格兼容规则失配: ${from.slice(0, 24)}`);
  return content.replace(from, to);
}

/** 保留本地 Collab 的 Tool→Soul 协议，只替换已经失效的浏览器插件说明。 */
export function adaptPersonaForTwoPhase(systemSource: string, soulSource: string): { system: string; soul: string } {
  const soul = replaceRequired(
    soulSource,
    "当用户让你做一件\"上网\"才能做的事（查网页、抓内容、点链接、爬新闻、填表单），你会用到以下工具:\n\n- **Playwright 浏览器自动化** —— `playwright-browser_*` 一系列工具（click / navigate / type / screenshot 等），**需要用户先在设置 → 🔌 插件里手动启用**\n\n如果用户让你做需要浏览器的事但 Playwright 还没开，如实告诉用户「我暂时没开浏览器，可以到 设置 → 插件 → 启用浏览器自动化(Playwright) 打开」，**不要硬装能做**。",
    "当用户请求联网或浏览器任务时，只使用宿主当前明确提供的工具并遵循其权限规则。若本轮没有相应能力，如实说明当前无法完成，不要假装已经访问或编造结果。",
  );
  return { system: systemSource, soul };
}

function resolvePersonaRoot(): string {
  const candidates = [path.join(__dirname, "persona"), path.join(__dirname, "..", "persona")];
  const root = candidates.find((candidate) => existsSync(candidate));
  if (!root) throw new Error("内置人格资源缺失");
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("内置人格资源目录无效");
  return realpathSync(root);
}

function readPersonaFile(root: string, relative: string): string {
  const file = path.join(root, relative);
  const resolved = realpathSync(file);
  if (path.relative(root, resolved).startsWith("..")) throw new Error("内置人格资源路径越界");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("内置人格资源无效");
  return readFileSync(file, "utf8").trim();
}

export function parsePersonaStyle(value: unknown): PersonaStyleId {
  return PERSONA_STYLE_IDS.includes(value as PersonaStyleId) ? value as PersonaStyleId : "01_default";
}

export function personaStyleFromHost(value: unknown): PersonaStyleId | null {
  const mapping: Record<string, PersonaStyleId> = {
    default: "01_default",
    lively: "02_lively",
    healing: "03_healing",
    focused: "04_focused",
    sweet: "05_sweet",
  };
  return typeof value === "string" ? mapping[value] ?? null : "01_default";
}

export function createPersonaService(root = resolvePersonaRoot()) {
  const adapted = adaptPersonaForTwoPhase(
    readPersonaFile(root, "system.md"),
    readPersonaFile(root, "soul.md"),
  );
  const identity = readPersonaFile(root, "identity.md");
  const talkSystem = readPersonaFile(root, "talk_system.md");
  const canon = readPersonaFile(root, "canon_quotes.md");
  const tool = readPersonaFile(root, "tools_system.md");
  const tone = readPersonaFile(root, "tone-rules.md");
  const tail = readPersonaFile(root, "tone-anchor.md");
  const styles = Object.fromEntries(PERSONA_STYLE_IDS.map((id) => [
    id,
    readPersonaFile(root, path.join("styles", STYLE_FILES[id])),
  ])) as Record<PersonaStyleId, string>;

  return {
    buildProactive(): string {
      return [talkSystem, adapted.soul.split("\n## Live2D 与聊天文字的分工")[0].trim(), canon, styles["01_default"]]
        .filter(Boolean)
        .join(SEPARATOR);
    },
    buildBase(addendum = ""): string {
      return [adapted.system, identity, adapted.soul, canon, addendum.trim()]
        .filter(Boolean)
        .join(SEPARATOR);
    },
    build(style: PersonaStyleId, addendum = ""): string {
      return [adapted.system, identity, adapted.soul, canon, styles[style], addendum.trim()]
        .filter(Boolean)
        .join(SEPARATOR);
    },
    buildTool(): string {
      return tool;
    },
    buildTone(): string {
      return tone;
    },
    buildTail(): string {
      return tail;
    },
  };
}
