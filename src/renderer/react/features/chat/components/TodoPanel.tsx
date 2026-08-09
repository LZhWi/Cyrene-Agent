import { useEffect, useMemo, useRef, useState } from "react";
import type { TodoState } from "../../../../shared/todo-types";
import reminderPngUrl from "../../../assets/status-moods/提醒.png?url";
import "./TodoPanel.css";

export interface TodoPanelProps {
  state: TodoState | null;
  mode: "work" | "daily" | "learn";
  workspaceName?: string;
}

const DEFAULT_WIDTH = 240;
const DEFAULT_TOP = 80;
const DEFAULT_RIGHT = 24;

const MODE_LABELS: Record<TodoPanelProps["mode"], string> = {
  work: "工作",
  daily: "日常",
  learn: "学习",
};

function EmptyCircleIcon() {
  return (
    <svg className="cy-todo__bullet" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" fill="none" stroke="#FF5B8A" strokeWidth="2" />
    </svg>
  );
}

function CheckedCircleIcon() {
  return (
    <svg className="cy-todo__bullet" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#FF5B8A" />
      <path
        d="M7 12l3 3 5-6"
        stroke="#fff"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ToggleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M27 9V21H39" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 39V27H9" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M27 21L42 6" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 27L6 42" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ModeCapsule({ mode }: { mode: TodoPanelProps["mode"] }) {
  return (
    <div className="cy-todo__mode-capsule">
      <span className="cy-todo__mode-dot" aria-hidden="true" />
      <span className="cy-todo__mode-label">{MODE_LABELS[mode]}</span>
    </div>
  );
}

export function TodoPanel({ state, mode, workspaceName }: TodoPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [pos, setPos] = useState({
    x: typeof window !== "undefined" ? window.innerWidth - DEFAULT_WIDTH - DEFAULT_RIGHT : 0,
    y: DEFAULT_TOP,
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
  } | null>(null);

  const todos = state?.todos ?? [];
  const total = todos.length;
  const completed = useMemo(() => todos.filter((t) => t.status === "completed").length, [todos]);
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        setIsDragging(true);
      }
      const maxX = window.innerWidth - DEFAULT_WIDTH;
      const maxY = window.innerHeight - 48;
      setPos({
        x: Math.min(Math.max(0, dragRef.current.initialX + dx), maxX),
        y: Math.min(Math.max(0, dragRef.current.initialY + dy), maxY),
      });
    };

    const handleUp = () => {
      dragRef.current = null;
      window.setTimeout(() => setIsDragging(false), 0);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".cy-todo__toggle")) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: pos.x,
      initialY: pos.y,
    };
  };

  const handleHeaderClick = () => {
    if (isDragging) return;
    setCollapsed((c) => !c);
  };

  return (
    <div
      className={`cy-todo ${collapsed ? "cy-todo--collapsed" : ""}`}
      style={{ left: pos.x, top: pos.y }}
      role="region"
      aria-label="当前任务"
    >
      <button
        type="button"
        className="cy-todo__dragbar"
        onMouseDown={handleHeaderMouseDown}
        onClick={handleHeaderClick}
        aria-expanded={!collapsed}
        title="拖动"
      >
        <span className="cy-todo__dragline" />
        <span
          className="cy-todo__toggle"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((c) => !c);
          }}
        >
          <ToggleIcon />
        </span>
      </button>

      <div className="cy-todo__body">
        <div className="cy-todo__capsule-row">
          <ModeCapsule mode={mode} />
        </div>

        <div className="cy-todo__hero">
          <img className="cy-todo__mascot" src={reminderPngUrl} alt="提醒" />
          <div className="cy-todo__hero-text">
            <div className="cy-todo__hero-title">当前任务</div>
            <div className="cy-todo__hero-sub">
              {completed}/{total} 已完成
            </div>
          </div>
        </div>

        <div className="cy-todo__divider" />

        <ul className="cy-todo__list" data-testid="todo-list">
          {total === 0 ? (
            <li className="cy-todo__item cy-todo__item--empty">
              <span className="cy-todo__status" aria-hidden="true">
                <EmptyCircleIcon />
              </span>
              <span className="cy-todo__content">暂无任务</span>
            </li>
          ) : (
            todos.map((todo) => {
              const isCompleted = todo.status === "completed";
              return (
                <li
                  key={todo.id}
                  className={`cy-todo__item ${isCompleted ? "cy-todo__item--completed" : ""}`}
                >
                  <span className="cy-todo__status" aria-hidden="true">
                    {isCompleted ? <CheckedCircleIcon /> : <EmptyCircleIcon />}
                  </span>
                  <span className="cy-todo__content">{todo.content}</span>
                </li>
              );
            })
          )}
        </ul>

        <div className="cy-todo__footer" data-testid="todo-footer">
          <div className="cy-todo__divider" />

          <div
            className="cy-todo__progress"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="cy-todo__progress-bar" style={{ width: `${progress}%` }} />
            <span className="cy-todo__progress-text">{progress}%</span>
          </div>

          <div className="cy-todo__workspace">
            <span className="cy-todo__workspace-label">当前工作路径</span>
            <span className="cy-todo__workspace-path" title={workspaceName}>
              {workspaceName ?? "未绑定工作区"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
