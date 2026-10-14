import { Dropdown, Input, Modal, Popover, Segmented, message } from "antd";
import { Folder, GripVertical, Hash, MoreHorizontal, Plus, Pin, ChevronRight } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import type { SidebarOrganizationDraft, SidebarOrganizationSnapshot } from "../../../../../shared/sidebar-organization";
import { useTranslation } from "../../../i18n";
import "./WorkspaceConversationSidebar.css";
import { sessionTime } from "./workspace-ui";

interface Props {
  mode: ConversationMode;
  sessions: ChatSessionMeta[];
  organization: SidebarOrganizationSnapshot;
  activeSessionId?: string;
  onSaveOrganization: (draft: SidebarOrganizationDraft) => Promise<boolean>;
  onSelect: (sessionId: string) => void;
  onOpenProject: (workspaceRoot: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
}

type NamedItem = { kind: "category" | "group"; id?: string; title: string; color: string };
type DragItem = { kind: "project" | "category" | "group" | "session"; id: string };
const DRAG_TYPE = "application/x-cyrene-sidebar";

function moveBefore(ids: string[], source: string, target: string): string[] {
  const next = ids.filter((id) => id !== source);
  const index = next.indexOf(target);
  if (index < 0) return ids;
  next.splice(index, 0, source);
  return next;
}

function dragStart(event: DragEvent, item: DragItem) {
  event.stopPropagation();
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
}

function dragged(event: DragEvent): DragItem | null {
  try {
    const item = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as DragItem;
    return item && typeof item.id === "string" && ["project", "category", "group", "session"].includes(item.kind) ? item : null;
  } catch {
    return null;
  }
}

export function WorkspaceConversationSidebar({
  sessions, organization, activeSessionId, onSaveOrganization, onSelect,
  onOpenProject, onRename, onDelete, onTogglePin,
}: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<"projects" | "groups">("projects");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [dialog, setDialog] = useState<NamedItem | null>(null);
  const [renameSession, setRenameSession] = useState<{ id: string; title: string } | null>(null);
  const allSessions = useMemo(() => sessions.filter((session) => session.mode === "work" || session.mode === "code"), [sessions]);
  const sessionById = useMemo(() => new Map(allSessions.map((session) => [session.id, session])), [allSessions]);
  const projectById = useMemo(() => new Map(organization.projects.map((project) => [project.id, project])), [organization]);
  const categoryById = useMemo(() => new Map(organization.projectCategories.map((category) => [category.id, category])), [organization]);
  const groupById = useMemo(() => new Map(organization.groups.map((group) => [group.id, group])), [organization]);
  const projectSessions = (root: string) => allSessions.filter((session) => session.workspaceRoot?.toLocaleLowerCase() === root.toLocaleLowerCase());
  const assignedProjects = new Set(Object.values(organization.projectCategoryMembers).flat());
  const ungroupedProjects = organization.projectOrder.filter((id) => !assignedProjects.has(id));
  const pinned = allSessions.filter((session) => session.pinned).sort((a, b) => b.updatedAt - a.updatedAt);

  async function save(draft: SidebarOrganizationDraft) {
    if (!await onSaveOrganization(draft)) message.error(t("sidebar.organizationSaveFailed"));
  }

  function dropProject(event: DragEvent, targetId: string, categoryId?: string) {
    event.preventDefault();
    event.stopPropagation();
    const item = dragged(event);
    if (!item || item.kind !== "project" || !projectById.has(item.id) || !projectById.has(targetId) || item.id === targetId) return;
    const members = Object.fromEntries(Object.entries(organization.projectCategoryMembers).map(([id, ids]) => [id, ids.filter((value) => value !== item.id)]));
    const order = moveBefore(organization.projectOrder, item.id, targetId);
    if (categoryId) {
      const targetMembers = members[categoryId] ?? [];
      const index = targetMembers.indexOf(targetId);
      targetMembers.splice(index < 0 ? targetMembers.length : index, 0, item.id);
      members[categoryId] = targetMembers;
    }
    void save({ ...organization, projectOrder: order, projectCategoryMembers: members });
  }

  function dropOnCategory(event: DragEvent, categoryId: string | null) {
    event.preventDefault();
    event.stopPropagation();
    const item = dragged(event);
    if (!item) return;
    if (item.kind === "category" && categoryId && categoryById.has(item.id) && categoryById.has(categoryId) && item.id !== categoryId) {
      const categories = [...organization.projectCategories];
      const sourceIndex = categories.findIndex((category) => category.id === item.id);
      const targetIndex = categories.findIndex((category) => category.id === categoryId);
      const [source] = categories.splice(sourceIndex, 1);
      categories.splice(targetIndex, 0, source);
      void save({ ...organization, projectCategories: categories });
      return;
    }
    if (item.kind !== "project" || !projectById.has(item.id) || categoryId && !categoryById.has(categoryId)) return;
    const members = Object.fromEntries(Object.entries(organization.projectCategoryMembers).map(([id, ids]) => [id, ids.filter((value) => value !== item.id)]));
    if (categoryId) members[categoryId] = [...(members[categoryId] ?? []), item.id];
    void save({ ...organization, projectCategoryMembers: members });
  }

  function dropInGroups(event: DragEvent, target: { kind: "group" | "session" | "root"; id?: string; groupId?: string }) {
    event.preventDefault();
    event.stopPropagation();
    const item = dragged(event);
    if (!item) return;
    if (item.kind === "group" && target.kind === "group" && target.id && groupById.has(item.id) && groupById.has(target.id) && item.id !== target.id) {
      const order = organization.topLevelOrder.filter((row) => !(row.type === "group" && row.groupId === item.id));
      const index = order.findIndex((row) => row.type === "group" && row.groupId === target.id);
      order.splice(index, 0, { type: "group", groupId: item.id });
      void save({ ...organization, topLevelOrder: order });
      return;
    }
    if (item.kind !== "session" || !sessionById.has(item.id) || item.id === target.id) return;
    const order = organization.topLevelOrder.filter((row) => !(row.type === "session" && row.sessionId === item.id));
    const members = Object.fromEntries(Object.entries(organization.groupMembers).map(([id, ids]) => [id, ids.filter((value) => value !== item.id)]));
    if (target.kind === "group" && target.id && groupById.has(target.id)) {
      members[target.id] = [...(members[target.id] ?? []), item.id];
    } else if (target.kind === "session" && target.id && sessionById.has(target.id)) {
      if (target.groupId && groupById.has(target.groupId)) {
        const list = members[target.groupId] ?? [];
        list.splice(list.indexOf(target.id), 0, item.id);
        members[target.groupId] = list;
      } else {
        const index = order.findIndex((row) => row.type === "session" && row.sessionId === target.id);
        order.splice(index, 0, { type: "session", sessionId: item.id });
      }
    } else if (target.kind === "root") {
      order.push({ type: "session", sessionId: item.id });
    } else return;
    void save({ ...organization, topLevelOrder: order, groupMembers: members });
  }

  function submitDialog() {
    if (!dialog?.title.trim()) return;
    const title = dialog.title.trim();
    if (dialog.kind === "category") {
      const id = dialog.id ?? crypto.randomUUID();
      const categories = dialog.id
        ? organization.projectCategories.map((category) => category.id === id ? { ...category, title, color: dialog.color } : category)
        : [...organization.projectCategories, { id, title, color: dialog.color }];
      void save({ ...organization, projectCategories: categories, projectCategoryMembers: { ...organization.projectCategoryMembers, [id]: organization.projectCategoryMembers[id] ?? [] } });
    } else {
      const id = dialog.id ?? crypto.randomUUID();
      const groups = dialog.id
        ? organization.groups.map((group) => group.id === id ? { ...group, title, color: dialog.color } : group)
        : [...organization.groups, { id, title, color: dialog.color }];
      void save({ ...organization, groups, topLevelOrder: dialog.id ? organization.topLevelOrder : [...organization.topLevelOrder, { type: "group", groupId: id }], groupMembers: { ...organization.groupMembers, [id]: organization.groupMembers[id] ?? [] } });
    }
    setDialog(null);
  }

  function deleteCategory(id: string) {
    void save({
      ...organization,
      projectCategories: organization.projectCategories.filter((category) => category.id !== id),
      projectCategoryMembers: Object.fromEntries(Object.entries(organization.projectCategoryMembers).filter(([key]) => key !== id)),
    });
  }

  function deleteGroup(id: string) {
    const members = organization.groupMembers[id] ?? [];
    void save({
      ...organization,
      groups: organization.groups.filter((group) => group.id !== id),
      topLevelOrder: [...organization.topLevelOrder.filter((row) => !(row.type === "group" && row.groupId === id)), ...members.map((sessionId) => ({ type: "session" as const, sessionId }))],
      groupMembers: Object.fromEntries(Object.entries(organization.groupMembers).filter(([key]) => key !== id)),
    });
  }

  function sessionRow(session: ChatSessionMeta, groupId?: string) {
    return <div key={session.id} className={`cy-organized-session ${activeSessionId === session.id ? "is-active" : ""}`}
      draggable={view === "groups"} onDragStart={(event) => dragStart(event, { kind: "session", id: session.id })}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => dropInGroups(event, { kind: "session", id: session.id, groupId })}
    >
      <GripVertical size={13} className="cy-organized-drag" />
      <button type="button" title={session.title} aria-current={activeSessionId === session.id ? "page" : undefined} onClick={() => onSelect(session.id)}>
        <span>{session.title || t("sidebar.defaultSessionTitle")}</span>
        <time dateTime={new Date(session.updatedAt).toISOString()}>{sessionTime(session.updatedAt)}</time>
      </button>
      {session.pinned && <Pin size={12} />}
      <Dropdown trigger={["click"]} menu={{ items: [
        { key: "rename", label: t("sidebar.rename"), onClick: () => setRenameSession({ id: session.id, title: session.title }) },
        { key: "pin", label: t(session.pinned ? "sidebar.unpin" : "sidebar.pin"), onClick: () => onTogglePin(session.id, !session.pinned) },
        ...organization.groups.map((group) => ({ key: group.id, label: `${t("sidebar.moveToGroup")}: ${group.title}`, onClick: () => {
          const order = organization.topLevelOrder.filter((row) => !(row.type === "session" && row.sessionId === session.id));
          const members = Object.fromEntries(Object.entries(organization.groupMembers).map(([id, ids]) => [id, ids.filter((value) => value !== session.id)]));
          members[group.id] = [...(members[group.id] ?? []), session.id];
          void save({ ...organization, topLevelOrder: order, groupMembers: members });
        } })),
        { key: "delete", label: t("sidebar.delete"), danger: true, onClick: () => Modal.confirm({ title: t("sidebar.deleteConfirmTitle", { title: session.title }), content: t("sidebar.deleteConfirmContent"), onOk: () => onDelete(session.id) }) },
      ] }}>
        <button type="button" className="cy-organized-more" aria-label={t("sidebar.sessionActions")}><MoreHorizontal size={15} /></button>
      </Dropdown>
    </div>;
  }

  function projectRow(id: string, categoryId?: string) {
    const project = projectById.get(id);
    if (!project || project.hidden) return null;
    const members = projectSessions(project.workspaceRoot);
    const open = expanded.includes(id);
    return <div key={id} className="cy-organized-project" draggable onDragStart={(event) => dragStart(event, { kind: "project", id })}
      onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropProject(event, id, categoryId)}>
      <div className="cy-organized-heading">
        <GripVertical size={13} className="cy-organized-drag" />
        <button type="button" onClick={() => setExpanded((current) => open ? current.filter((value) => value !== id) : [...current, id])}>
          <ChevronRight size={13} className={open ? "is-open" : ""} /><Folder size={15} />
          <span title={project.workspaceRoot}>{members[0]?.workspaceDisplayName || project.workspaceRoot.split(/[\\/]/).pop()}</span>
          <small>{members.length}</small>
        </button>
        <Popover placement="right" content={<section className="cy-organized-project-info">
          <strong>{members[0]?.workspaceDisplayName || project.workspaceRoot.split(/[\\/]/).pop()}</strong>
          <p>{t("sidebar.conversationCountLabel")}：{members.length}</p>
          <p>{t("sidebar.projectPathLabel")}：{project.workspaceRoot}</p>
          {members.length > 0 && <p>{t("sidebar.lastModifiedLabel")}：{sessionTime(Math.max(...members.map((session) => session.updatedAt)))}</p>}
          <button type="button" onClick={() => onOpenProject(project.workspaceRoot)}>{t("sidebar.openProjectFolder")}</button>
        </section>}><button type="button" className="cy-organized-more" aria-label={t("sidebar.projectInfoAria", { name: project.workspaceRoot })}>ⓘ</button></Popover>
        <Dropdown trigger={["click"]} menu={{ items: [
          { key: "open", label: t("sidebar.openProjectFolder"), onClick: () => onOpenProject(project.workspaceRoot) },
          { key: "hide", label: t("sidebar.hideProject"), onClick: () => void save({ ...organization, projects: organization.projects.map((value) => value.id === id ? { ...value, hidden: true } : value) }) },
        ] }}><button type="button" className="cy-organized-more" aria-label={t("sidebar.projectActions")}><MoreHorizontal size={15} /></button></Dropdown>
      </div>
      {open && <div className="cy-organized-children">{members.filter((session) => !session.pinned).map((session) => sessionRow(session))}</div>}
    </div>;
  }

  return <nav className="cy-workspace-organizer" aria-label={t("sidebar.projectsAndConversationsAria")}>
    <div className="cy-organized-toolbar">
      <Segmented size="small" value={view} onChange={(value) => setView(value as typeof view)}
        options={[{ value: "projects", label: <><Folder size={12} />{t("sidebar.projectsTitle")}</> }, { value: "groups", label: <><Hash size={12} />{t("sidebar.groupsView")}</> }]} />
      <button type="button" title={t(view === "projects" ? "sidebar.createProjectCategory" : "sidebar.createGroup")}
        onClick={() => setDialog({ kind: view === "projects" ? "category" : "group", title: "", color: "#ff5b8a" })}><Plus size={16} /></button>
    </div>
    <div className="cy-organized-scroll">
      {pinned.length > 0 && <section><div className="cy-organized-section-label">{t("sidebar.pinned")}</div>{pinned.map((session) => sessionRow(session))}</section>}
      {view === "projects" ? <>
        {organization.projectCategories.map((category) => <section key={category.id} className="cy-organized-category"
          draggable onDragStart={(event) => dragStart(event, { kind: "category", id: category.id })}
          onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropOnCategory(event, category.id)}>
          <div className="cy-organized-heading"><GripVertical size={13} className="cy-organized-drag" /><span className="cy-organized-dot" style={{ background: category.color }} /> <strong>{category.title}</strong>
            <Dropdown trigger={["click"]} menu={{ items: [
              { key: "rename", label: t("sidebar.rename"), onClick: () => setDialog({ kind: "category", id: category.id, title: category.title, color: category.color }) },
              { key: "delete", label: t("sidebar.delete"), onClick: () => deleteCategory(category.id) },
            ] }}><button type="button" className="cy-organized-more" aria-label={t("sidebar.categoryActions")}><MoreHorizontal size={15} /></button></Dropdown>
          </div>
          {(organization.projectCategoryMembers[category.id] ?? []).map((id) => projectRow(id, category.id))}
        </section>)}
        <section onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropOnCategory(event, null)}>
          <div className="cy-organized-section-label">{t("sidebar.uncategorizedProjects")}</div>
          {ungroupedProjects.map((id) => projectRow(id))}
          {allSessions.filter((session) => !session.workspaceRoot && !session.pinned).map((session) => sessionRow(session))}
        </section>
        {organization.projects.some((project) => project.hidden) && <section>
          <div className="cy-organized-section-label">{t("sidebar.hiddenProjects")}</div>
          {organization.projects.filter((project) => project.hidden).map((project) => <button key={project.id}
            className="cy-organized-restore" type="button"
            onClick={() => void save({ ...organization, projects: organization.projects.map((item) => item.id === project.id ? { ...item, hidden: false } : item) })}>
            <Folder size={14} />{projectSessions(project.workspaceRoot)[0]?.workspaceDisplayName || project.workspaceRoot.split(/[\\/]/).pop()} · {t("sidebar.restoreProject")}
          </button>)}
        </section>}
      </> : <>
        {organization.topLevelOrder.map((row) => {
          if (row.type === "session") {
            const session = sessionById.get(row.sessionId);
            return session && !session.pinned ? sessionRow(session) : null;
          }
          const group = groupById.get(row.groupId);
          if (!group) return null;
          const members = (organization.groupMembers[group.id] ?? []).map((id) => sessionById.get(id)).filter((session): session is ChatSessionMeta => Boolean(session && !session.pinned));
          const open = expanded.includes(group.id);
          return <section key={group.id} className="cy-organized-group" draggable onDragStart={(event) => dragStart(event, { kind: "group", id: group.id })}
            onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropInGroups(event, { kind: "group", id: group.id })}>
            <div className="cy-organized-heading"><GripVertical size={13} className="cy-organized-drag" />
              <button type="button" onClick={() => setExpanded((current) => open ? current.filter((value) => value !== group.id) : [...current, group.id])}>
                <ChevronRight size={13} className={open ? "is-open" : ""} /><span className="cy-organized-dot" style={{ background: group.color }} /> <strong>{group.title}</strong><small>{members.length}</small>
              </button>
              <Dropdown trigger={["click"]} menu={{ items: [
                { key: "rename", label: t("sidebar.rename"), onClick: () => setDialog({ kind: "group", id: group.id, title: group.title, color: group.color }) },
                { key: "delete", label: t("sidebar.delete"), onClick: () => deleteGroup(group.id) },
              ] }}><button type="button" className="cy-organized-more" aria-label={t("sidebar.groupActions")}><MoreHorizontal size={15} /></button></Dropdown>
            </div>
            {open && <div className="cy-organized-children">{members.map((session) => sessionRow(session, group.id))}</div>}
          </section>;
        })}
        <div className="cy-organized-root-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropInGroups(event, { kind: "root" })}>{t("sidebar.dropToUngroup")}</div>
      </>}
    </div>
    <Modal open={Boolean(dialog)} title={t(dialog?.kind === "category" ? "sidebar.projectCategoryTitle" : "sidebar.groupTitle")}
      okText={t("common.confirm")} cancelText={t("common.cancel")} onCancel={() => setDialog(null)} onOk={submitDialog} destroyOnHidden>
      <Input autoFocus value={dialog?.title ?? ""} onChange={(event) => setDialog((current) => current ? { ...current, title: event.target.value } : null)} onPressEnter={submitDialog} />
      <input className="cy-organized-color" type="color" value={dialog?.color ?? "#ff5b8a"} onChange={(event) => setDialog((current) => current ? { ...current, color: event.target.value } : null)} />
    </Modal>
    <Modal open={Boolean(renameSession)} title={t("sidebar.rename")} okText={t("common.confirm")} cancelText={t("common.cancel")}
      onCancel={() => setRenameSession(null)} onOk={() => { if (renameSession?.title.trim()) onRename(renameSession.id, renameSession.title.trim()); setRenameSession(null); }} destroyOnHidden>
      <Input autoFocus value={renameSession?.title ?? ""} onChange={(event) => setRenameSession((current) => current ? { ...current, title: event.target.value } : null)} />
    </Modal>
  </nav>;
}
