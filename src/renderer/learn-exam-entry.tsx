import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { XMarkdown } from "@ant-design/x-markdown";
import Latex from "@ant-design/x-markdown/plugins/Latex";
import type { LearnExamAnswerValue, LearnExamPageApi, LearnExamQuestionView, LearnExamView } from "../shared/learn-exam";
import { createExamAnswerQueue } from "./learn-exam-answer-queue";
import { isExamQuestionAnswered } from "./learn-exam-progress";
import "./learn-exam-page.css";

const api = (window as unknown as { learnExamPage: LearnExamPageApi }).learnExamPage;
const labels = { single_choice: "单选题", multiple_choice: "多选题", true_false: "判断题", fill_blank: "填空题", short_answer: "简答题", essay: "解答题" };
const markdownConfig = { extensions: Latex() };

function Answer({ question, answer, locked, onChange }: {
  question: LearnExamQuestionView; answer?: LearnExamAnswerValue; locked: boolean;
  onChange(value: string | string[] | boolean): void;
}) {
  if (question.type === "single_choice" || question.type === "multiple_choice") return <div>
    {question.options?.map((option) => <label className="exam-option" key={option.id}>
      <input type={question.type === "single_choice" ? "radio" : "checkbox"} name={question.id}
        disabled={locked} checked={question.type === "single_choice" ? answer?.value === option.id : Array.isArray(answer?.value) && answer.value.includes(option.id)}
        onChange={(event) => {
          if (question.type === "single_choice") onChange(option.id);
          else {
            const values = Array.isArray(answer?.value) ? answer.value : [];
            onChange(event.target.checked ? [...values, option.id] : values.filter((id) => id !== option.id));
          }
        }} />
      <XMarkdown content={option.label} config={markdownConfig} escapeRawHtml />
    </label>)}
  </div>;
  if (question.type === "true_false") return <div>{[true, false].map((value) => <label className="exam-option" key={String(value)}>
    <input type="radio" name={question.id} disabled={locked} checked={answer?.value === value} onChange={() => onChange(value)} />{value ? "正确" : "错误"}
  </label>)}</div>;
  if (question.type === "fill_blank") return <div>{Array.from({ length: question.blankCount ?? 0 }, (_, index) => <label className="exam-blank" key={index}>
    第 {index + 1} 空<input disabled={locked} value={Array.isArray(answer?.value) ? answer.value[index] ?? "" : ""}
      onChange={(event) => {
        const values = Array.from({ length: question.blankCount ?? 0 }, (_, i) => Array.isArray(answer?.value) ? answer.value[i] ?? "" : "");
        values[index] = event.target.value;
        onChange(values);
      }} />
  </label>)}</div>;
  return <textarea aria-label="答案" rows={6} disabled={locked} value={typeof answer?.value === "string" ? answer.value : ""} onChange={(event) => onChange(event.target.value)} />;
}

function ExamPage() {
  const [exam, setExam] = useState<LearnExamView | null>(null);
  const [answers, setAnswers] = useState<Record<string, LearnExamAnswerValue>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [activeQuestionId, setActiveQuestionId] = useState("");
  const [flagged, setFlagged] = useState<string[]>([]);
  const navigationRef = useRef({ activeQuestionId: "", flagged: [] as string[] });
  const navigationQueue = useRef<Promise<void>>(Promise.resolve());
  const lockedRef = useRef(false);
  const queue = useRef(createExamAnswerQueue(async (id, answer) => (await api.saveAnswer(id, answer)).ok)).current;
  useEffect(() => {
    let disposed = false;
    async function refresh(initial = false) {
      try {
        const result = await api.getExam();
        if (disposed) return;
        if (!result.ok || !result.exam) throw new Error(result.error ?? "无法读取试卷");
        setExam(result.exam);
        if (initial || result.exam.status !== "draft") setAnswers(result.exam.answers);
        if (initial) {
          const activeQuestionId = result.exam.activeQuestionId || result.exam.questions[0]?.id || "";
          setActiveQuestionId(activeQuestionId); setFlagged(result.exam.flaggedQuestionIds);
          navigationRef.current = { activeQuestionId, flagged: result.exam.flaggedQuestionIds };
        }
        document.title = `${result.exam.title} · 学习试卷`;
      } catch (error) { if (!disposed) setError(String(error)); }
    }
    const off = api.onChanged(() => void refresh());
    void refresh(true);
    return () => { disposed = true; off(); };
  }, []);
  if (!exam) return <main role={error ? "alert" : "status"}>{error || "正在载入试卷…"}</main>;
  const locked = busy || exam.status !== "draft";
  const answeredCount = exam.questions.filter((question) => isExamQuestionAnswered(question, answers[question.id])).length;
  const activeIndex = Math.max(0, exam.questions.findIndex((question) => question.id === activeQuestionId));
  function saveNavigation() {
    const current = navigationRef.current;
    const saved = navigationQueue.current.catch(() => {}).then(async () => {
      const result = await api.saveNavigation(current.activeQuestionId, current.flagged);
      if (!result.ok) throw new Error(result.error ?? "题目导航保存失败");
    });
    navigationQueue.current = saved;
    void saved.catch((error) => setError(String(error)));
    return saved;
  }
  function navigate(id: string) {
    setActiveQuestionId(id);
    document.getElementById(`question-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    navigationRef.current = { ...navigationRef.current, activeQuestionId: id };
    if (!locked && !lockedRef.current) void saveNavigation();
  }
  function toggleFlag(id: string) {
    if (locked || lockedRef.current) return;
    const next = navigationRef.current.flagged.includes(id) ? navigationRef.current.flagged.filter((value) => value !== id) : [...navigationRef.current.flagged, id];
    setFlagged(next); navigationRef.current = { ...navigationRef.current, flagged: next };
    void saveNavigation();
  }
  async function submit() {
    if (lockedRef.current) return;
    lockedRef.current = true;
    setBusy(true);
    try {
      await queue.flush();
      await navigationQueue.current;
      const result = await api.submit();
      if (!result.ok || !result.exam) throw new Error(result.error ?? "交卷失败");
      setExam(result.exam); setAnswers(result.exam.answers); setConfirm(false); setError("");
    } catch (error) { setError(String(error)); }
    finally { lockedRef.current = false; setBusy(false); }
  }
  return <div className="exam-layout">
    <aside className="exam-navigation" aria-label="题目导航">
      <strong>完成进度 {answeredCount}/{exam.questions.length}</strong>
      <progress value={answeredCount} max={exam.questions.length} aria-label="答题进度" />
      <p>✓ 已作答　⚑ 待检查</p>
      <div className="exam-navigation__grid">{exam.questions.map((question, index) => <button type="button" key={question.id}
        aria-label={`第 ${index + 1} 题${flagged.includes(question.id) ? "，待检查" : ""}`} aria-current={question.id === activeQuestionId ? "step" : undefined}
        className={isExamQuestionAnswered(question, answers[question.id]) ? "is-answered" : ""} onClick={() => navigate(question.id)}>
        {index + 1}{flagged.includes(question.id) ? " ⚑" : isExamQuestionAnswered(question, answers[question.id]) ? " ✓" : ""}
      </button>)}</div>
      <div className="exam-navigation__controls">
        <button type="button" disabled={activeIndex === 0} onClick={() => navigate(exam.questions[activeIndex - 1].id)}>上一题</button>
        <button type="button" disabled={activeIndex === exam.questions.length - 1} onClick={() => navigate(exam.questions[activeIndex + 1].id)}>下一题</button>
      </div>
    </aside>
    <main className="exam-page">
    <header><h1>{exam.title}</h1><p>{exam.subject} · {exam.totalPoints} 分 · 建议 {exam.durationMinutes} 分钟（不强制计时）</p></header>
    {error && <div className="exam-error" role="alert">{error}<button disabled={busy} onClick={async () => {
      setBusy(true);
      try { await queue.retry(); if (exam.status === "draft") await saveNavigation(); setError(""); } catch (error) { setError(String(error)); }
      finally { setBusy(false); }
    }}>重试保存</button></div>}
    {exam.status !== "draft" && <p role="status">{exam.status === "graded" ? "批改已完成" : exam.status === "grading" ? "正在批改" : "答案已冻结。请回到所属 Learn 会话，点击试卷的“开始批改”。"}</p>}
    {exam.questions.map((question, index) => <section className="exam-question" id={`question-${question.id}`} key={question.id}>
      <div className="exam-question__heading"><h2>{index + 1}. {labels[question.type]} · {question.points} 分</h2>
        <button type="button" disabled={locked} aria-pressed={flagged.includes(question.id)} onClick={() => toggleFlag(question.id)}>{flagged.includes(question.id) ? "⚑ 取消标记" : "⚑ 待检查"}</button>
      </div>
      <XMarkdown content={question.prompt} config={markdownConfig} escapeRawHtml />
      <Answer question={question} answer={answers[question.id]} locked={locked} onChange={(value) => {
        if (lockedRef.current) return;
        const answer = { value };
        setAnswers((current) => ({ ...current, [question.id]: answer }));
        void queue.set(question.id, answer).catch((error) => setError(String(error)));
      }} />
      {exam.gradingResult?.questionResults.filter((result) => result.questionId === question.id).map((result) => <div className="exam-feedback" key={result.questionId}>
        <strong>得分 {result.awardedPoints} / {question.points}</strong><XMarkdown content={result.feedback} config={markdownConfig} escapeRawHtml />
      </div>)}
    </section>)}
    {exam.status === "draft" && <footer>{confirm ? <>
      <p>交卷后答案不可修改。还有 {exam.questions.length - answeredCount} 题未完成、{flagged.length} 题待检查，确认继续吗？</p>
      <button disabled={busy} onClick={() => void submit()}>{busy ? "正在保存并交卷…" : "确认交卷"}</button>
      <button disabled={busy} onClick={() => setConfirm(false)}>继续作答</button>
    </> : <button disabled={busy} onClick={() => setConfirm(true)}>交卷</button>}</footer>}
    {exam.gradingResult && <section className="exam-question"><h2>总分 {exam.gradingResult.totalScore} / {exam.totalPoints}</h2>
      <XMarkdown content={exam.gradingResult.summary} config={markdownConfig} escapeRawHtml />
      {exam.gradingResult.abilityAnalysis.map((item, index) => <p key={index}>{item.ability}：{item.score}/{item.total}，{item.feedback}</p>)}
      <h3>下一步</h3><ul>{exam.gradingResult.nextSteps.map((step, index) => <li key={index}>{step}</li>)}</ul>
    </section>}
  </main></div>;
}

createRoot(document.getElementById("learn-exam-root")!).render(<ExamPage />);
