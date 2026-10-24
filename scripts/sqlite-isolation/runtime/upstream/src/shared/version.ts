/**
 * 插件版本号工具。
 * 插件版本接受完整 SemVer 2.0（主.次.修订 + 可选预发布号 / build 元数据），
 * 不允许前导零；市场端与安装端（loader）共用同一份规则，避免两边口径不一致。
 */

/** 完整 SemVer 2.0 语法（loader 与市场校验共用，勿在别处另写一份） */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** 判断字符串是否为合法的插件版本号（如 "0.1.0"、"2.0.0-beta.1"） */
export function isValidPluginVersion(v: string): boolean {
  return typeof v === "string" && SEMVER_PATTERN.test(v.trim());
}

/** 拆出核心三段数字与预发布标识符列表（build 元数据不参与优先级比较） */
function parseSemver(v: string): { core: [number, number, number]; pre: string[] } {
  const m = SEMVER_PATTERN.exec(v);
  // 调用方已用 isValidPluginVersion 保证匹配，m 不会为 null
  const core: [number, number, number] = [Number(m![1]), Number(m![2]), Number(m![3])];
  const pre = m![4] ? m![4].split(".") : [];
  return { core, pre };
}

/** 按 SemVer 2.0 优先级比较：大于返回 1、小于返回 -1、相等返回 0 */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1;
  }
  // 核心版本相同：正式版高于预发布版
  const aPre = pa.pre.length > 0;
  const bPre = pb.pre.length > 0;
  if (!aPre && !bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  // 逐个比较预发布标识符：数字按数值比，字母按 ASCII 比，数字低于字母
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const xn = Number(x);
      const yn = Number(y);
      if (xn !== yn) return xn > yn ? 1 : -1;
    } else if (xNum) {
      return -1;
    } else if (yNum) {
      return 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  // 前缀全部相同时，标识符更多的一方优先级更高
  if (pa.pre.length !== pb.pre.length) return pa.pre.length > pb.pre.length ? 1 : -1;
  return 0;
}

/**
 * 判断 candidate 是否严格高于 baseline（SemVer 2.0 优先级）。
 * 预发布号低于对应正式版；build 元数据不参与比较。
 * 两个版本都必须合法；任一非法直接返回 false（调用方应先校验合法性）。
 */
export function isNewerVersion(candidate: string, baseline: string): boolean {
  if (!isValidPluginVersion(candidate) || !isValidPluginVersion(baseline)) {
    return false;
  }
  return compareSemver(candidate.trim(), baseline.trim()) > 0;
}
