// Skill 面板：列 skill 开关 + MiniMax 办公合集折叠组
// 从 settings.ts 抽离。renderSkills 导出供 settings.ts 切换标签时按需调用。

interface SkillItem {
  id: string;
  name: string;
  description: string;
  tools: string[];
  enabled: boolean;
  source: string;
  version?: string;
  references: string[];
}

export async function renderSkills(): Promise<void> {
  const listEl = document.getElementById("skills-list");
  const emptyEl = document.getElementById("skills-empty");
  if (!listEl || !window.settings?.listSkills) return;

  let skills: SkillItem[] = [];
  try {
    skills = await window.settings.listSkills();
  } catch (err) {
    console.warn("[settings] 加载 skill 列表失败:", err);
  }

  listEl.innerHTML = "";
  if (skills.length === 0) {
    if (emptyEl) emptyEl.classList.remove("is-hidden");
    return;
  }
  if (emptyEl) emptyEl.classList.add("is-hidden");

  // MiniMax 办公合集 id 列表
  const officeGroupIds = new Set(["docx", "pdf", "pptx-generator", "xlsx"]);
  const officeSkills = skills.filter((s) => officeGroupIds.has(s.id));
  const otherSkills = skills.filter((s) => !officeGroupIds.has(s.id));

  // 渲染单条 skill
  function renderSkillRow(s: SkillItem): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "skill-row";
    const label = document.createElement("div");
    label.className = "skill-row__info";
    const title = document.createElement("div");
    title.className = "skill-row__title";
    title.textContent = s.name + (s.source === "user" ? " （用户）" : "");
    const desc = document.createElement("div");
    desc.className = "skill-row__desc";
    const short = s.description.length > 120 ? s.description.slice(0, 120) + "…" : s.description;
    const toolsStr = s.tools.length > 0 ? ` [tools: ${s.tools.join(", ")}]` : "";
    desc.textContent = short + toolsStr;
    label.appendChild(title);
    label.appendChild(desc);

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "skill-toggle";
    toggle.checked = s.enabled;
    toggle.addEventListener("change", async () => {
      try {
        await window.settings?.setSkillEnabled?.(s.id, toggle.checked);
      } catch (err) {
        console.warn("[settings] 切换 skill 失败:", err);
        toggle.checked = !toggle.checked;
      }
    });

    row.appendChild(label);
    row.appendChild(toggle);
    return row;
  }

  // 渲染其他（非合集）skill
  for (const s of otherSkills) {
    listEl.appendChild(renderSkillRow(s));
  }

  // MiniMax 办公合集折叠组
  if (officeSkills.length > 0) {
    const group = document.createElement("div");
    group.className = "skill-group";

    const header = document.createElement("div");
    header.className = "skill-group__header";
    const arrow = document.createElement("span");
    arrow.className = "skill-group__arrow";
    arrow.textContent = "▶";
    const gTitle = document.createElement("span");
    gTitle.className = "skill-group__title";
    gTitle.textContent = "MiniMAX-office-skills";
    const gDesc = document.createElement("span");
    gDesc.className = "skill-group__desc";
    gDesc.textContent = "MiniMax开源的办公文档Skills合集";
    header.appendChild(arrow);
    header.appendChild(gTitle);
    header.appendChild(gDesc);
    const body = document.createElement("div");
    body.className = "skill-group__body";

    header.addEventListener("click", () => {
      body.classList.toggle("is-open");
      arrow.textContent = body.classList.contains("is-open") ? "▼" : "▶";
    });

    for (const s of officeSkills) {
      body.appendChild(renderSkillRow(s));
    }

    group.appendChild(header);
    group.appendChild(body);
    listEl.appendChild(group);
  }
}
