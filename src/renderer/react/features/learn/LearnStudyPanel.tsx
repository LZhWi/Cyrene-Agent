import { useEffect, useRef, useState } from "react";
import type { LearnStudyHostApi, LearnStudyOverview, LearnReviewView, LearnVideoView } from "../../../../shared/learn-study";
import type { PopQuizAnswerSubmission } from "../../../../shared/pop-quiz";
import "./LearnStudyPanel.css";

function time(seconds: number): string {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60].map((value) => String(value).padStart(2, "0")).join(":");
}
function userError(error: unknown): string {
  const message = String(error);
  if (message.includes("BINDING_CHANGED")) return "学习目录已变化，请刷新学习记录后再操作。";
  if (message.includes("E_LEARN_STUDY_FORBIDDEN")) return "请先为当前 Learn 会话绑定学习目录。";
  if (message.includes("PATH") || message.includes("E_LEARN_VIDEO_FILE")) return "请选择当前学习目录内受支持的视频或字幕文件。";
  if (message.includes("FORMAT")) return "学习记录格式无法读取，原文件已保留，请在 Obsidian 中检查。";
  if (message.includes("材料已变化")) return "材料已变化，请在 Learn 中重新核对并出题。";
  if (message.includes("已变化")) return "学习目录已变化，请重新选择文件。";
  return "学习操作未完成，请重试。";
}
function ReviewQuestion({ item, submit }: { item: LearnReviewView; submit(answer: PopQuizAnswerSubmission): Promise<string> }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [result, setResult] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  return <fieldset disabled={saving || Boolean(result)} className="cy-learn-study__question">
    <legend>{item.learningObjective} · {item.kind === "transfer" ? "应用迁移" : "材料复习"}</legend>
    <p>{item.question}</p>
    {item.type === "short_answer" ? <textarea aria-label="复习简答" value={text} onChange={(event) => setText(event.target.value)} />
      : (item.type === "true_false" ? [{ id: "true", label: "正确" }, { id: "false", label: "错误" }] : item.options).map((option) => <label key={option.id}>
        <input type={item.type === "multi" ? "checkbox" : "radio"} name={`review-${item.id}`} checked={selected.includes(option.id)} onChange={(event) => setSelected(item.type === "multi" ? event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id) : [option.id])} /> {option.label}
      </label>)}
    <button type="button" disabled={item.type === "short_answer" ? !text.trim() : !selected.length} onClick={async () => {
      if (savingRef.current) return;
      savingRef.current = true; setSaving(true);
      try {
        const answer: PopQuizAnswerSubmission = { questionId: "q1" };
        if (item.type === "short_answer") answer.text = text;
        else if (item.type === "true_false") answer.boolean = selected[0] === "true";
        else if (item.type === "multi") answer.optionIds = selected;
        else answer.optionId = selected[0];
        setResult(await submit(answer));
      } finally { savingRef.current = false; setSaving(false); }
    }}>提交复习作答</button>
    {result && <p role="status">{result}</p>}
  </fieldset>;
}

export function LearnStudyPanel({ conversationId, busy }: { conversationId: string; busy: boolean }) {
  const api = (window as unknown as { learnStudy?: LearnStudyHostApi }).learnStudy;
  const [overview, setOverview] = useState<LearnStudyOverview>();
  const [videos, setVideos] = useState<LearnVideoView[]>([]);
  const [videoId, setVideoId] = useState("");
  const [review, setReview] = useState<LearnReviewView & { workspaceId: string }>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [seconds, setSeconds] = useState(0);
  const player = useRef<HTMLVideoElement>(null);
  const active = useRef(true);
  const operation = useRef(false);
  const revision = useRef(0);
  const attempts = useRef(new Map<string, string>());
  async function load() {
    if (!api) return;
    const current = ++revision.current;
    const [next, nextVideos] = await Promise.all([api.overview(conversationId), api.videos(conversationId)]);
    if (!active.current || current !== revision.current) return;
    setOverview(next); setVideos(nextVideos);
  }
  useEffect(() => {
    active.current = true;
    void load().catch((error) => { if (active.current) setError(userError(error)); });
    const off = api?.onWorkspaceChanged?.((id) => {
      if (id !== conversationId) return;
      revision.current++; setOverview(undefined); setVideos([]); setVideoId(""); setReview(undefined); setNote(""); setSeconds(0); attempts.current.clear();
      void load().catch((error) => { if (active.current) setError(userError(error)); });
    });
    return () => { active.current = false; revision.current++; off?.(); };
  }, [api, conversationId, busy]);
  async function action(fn: () => Promise<void>) {
    if (operation.current || !api) return;
    operation.current = true; setSaving(true); setError("");
    try { await fn(); if (active.current) await load(); }
    catch (error) { if (active.current) setError(userError(error)); }
    finally { operation.current = false; if (active.current) setSaving(false); }
  }
  const video = videos.find((value) => value.id === videoId) ?? videos[0];
  const highlighted = video?.entries.filter((entry) => entry.seconds <= seconds).at(-1)?.id;
  if (!api) return null;
  return <details className="cy-learn-study">
    <summary>学习面板{overview ? ` · 到期复习 ${overview.dueCount} · 待讲评 ${overview.pendingCount}` : ""}</summary>
    <div className="cy-learn-study__body">
      <button type="button" disabled={saving || busy} onClick={() => void action(async () => {})}>刷新学习记录</button>
      {error && <p role="alert">{error}</p>}
      {overview && <>
        <h3>作答记录与复习</h3>
        <p>到期 {overview.dueCount} 项；待讲评 {overview.pendingCount} 项。待讲评时，可在 Learn 对话中说“讲评待批改的复习作答”。</p>
        {overview.weakTopics.length > 0 && <ul>{overview.weakTopics.map((topic) => <li key={topic.objective}>{topic.objective}：最近作答未完全正确 {topic.incorrect}／{topic.assessed} 题</li>)}</ul>}
        {!overview.reviews.length && <p>完成抽查或批改正式试卷后，作答记录会出现在这里。</p>}
        <ul className="cy-learn-study__reviews">{overview.reviews.map((item) => <li key={item.id}>
          <span>{item.learningObjective} · {item.origin === "exam" ? "试卷" : "抽查"} · {item.lastResult === "correct" ? "答对" : item.lastResult === "incorrect" ? "未完全正确" : "待讲评"} · {item.nextReviewAt ? `下次 ${new Date(item.nextReviewAt).toLocaleDateString()}` : "待讲评"}</span>
          {item.source && <small>来源：{item.source.file}{item.source.heading ? ` · ${item.source.heading}` : ""}</small>}
          <small>{item.sourceStatus === "stale" ? "材料已变化，请重新核对" : item.sourceStatus === "unverified" ? "未校验材料来源" : "原文版本与引文已校验"}</small>
          <button type="button" disabled={saving || busy || item.sourceStatus === "stale" || item.lastResult === "pending_model"} onClick={() => setReview({ ...item, workspaceId: overview.workspaceId })}>复习这道题</button>
        </li>)}</ul>
        {review && <ReviewQuestion key={`${review.id}:${review.attemptCount}`} item={review} submit={async (answer) => {
          let attemptId = attempts.current.get(review.id);
          if (!attemptId) { attemptId = crypto.randomUUID(); attempts.current.set(review.id, attemptId); }
          try {
            const result = await api.answer(conversationId, review.workspaceId, review.id, attemptId, answer);
            attempts.current.delete(review.id);
            if (active.current) {
              await load().catch((error) => { if (active.current) setError(userError(error)); });
              return `${result.result === "correct" ? "答对" : result.result === "incorrect" ? "未完全正确" : "待讲评"}：${result.explanation}`;
            }
            return "";
          } catch (error) { if (active.current) setError(userError(error)); return ""; }
        }} />}
        {overview.estimatedTopics.length > 0 && <details><summary>对话估计（粗略参考）</summary>
          <ul>{overview.estimatedTopics.map((topic) => <li key={topic.topic}>{topic.topic}：{topic.mastery}%</li>)}</ul>
          <p>这些数字来自教学对话推断，与实际作答记录分开。</p>
        </details>}
      </>}
      <h3>课程视频与时间轴笔记</h3>
      <button type="button" disabled={saving || busy} onClick={() => void action(async () => {
        const selected = await api.chooseVideo(conversationId); if (selected && active.current) { setVideoId(selected.id); setSeconds(0); setNote(""); }
      })}>选择 Vault 内视频</button>
      {videos.length > 0 && <select aria-label="课程视频" value={video?.id} disabled={saving || busy} onChange={(event) => { setVideoId(event.target.value); setSeconds(0); setNote(""); }}>
        {videos.map((value) => <option key={value.id} value={value.id}>{value.file}</option>)}
      </select>}
      {video && <>
        <video key={video.id} ref={player} src={video.url} controls preload="metadata" onTimeUpdate={() => setSeconds(player.current?.currentTime ?? 0)} onError={() => setError("视频无法播放，请确认原文件存在且编码受支持。推荐 H.264 MP4 或 WebM。")} />
        <label>当前时间 {time(seconds)}<textarea aria-label="时间点笔记" disabled={saving || busy} value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录当前画面的重点或疑问" /></label>
        <button type="button" disabled={saving || busy || !note.trim()} onClick={() => void action(async () => { await api.addVideoNote(conversationId, video.workspaceId, video.id, player.current?.currentTime ?? seconds, note); if (active.current) setNote(""); })}>保存当前时间点笔记</button>
        <button type="button" disabled={saving || busy} onClick={() => void action(() => api.importSubtitles(conversationId, video.workspaceId, video.id))}>导入 SRT/VTT 字幕</button>
        <ol className="cy-learn-study__timeline">{video.entries.map((entry) => <li key={entry.id} data-current={entry.id === highlighted}>
          <button type="button" onClick={() => { if (player.current) player.current.currentTime = entry.seconds; setSeconds(entry.seconds); }}>{time(entry.seconds)} · {entry.kind === "subtitle" ? "字幕" : "笔记"}</button>
          <p>{entry.text}</p>
        </li>)}</ol>
      </>}
    </div>
  </details>;
}
