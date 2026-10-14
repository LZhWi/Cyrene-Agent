import { useEffect, useRef, useState } from "react";
import type { LearnExamView } from "../../../../../shared/learn-exam";
import type { LearnExamHostApi } from "../../../../../shared/learn-exam-host";
import { LearnStudyPanel } from "../../learn/LearnStudyPanel";

export function LearnExamList({ conversationId, busy, onGrade }: {
  conversationId: string; busy: boolean; onGrade(exam: LearnExamView): Promise<void>;
}) {
  const api = (window as unknown as { learnExams?: LearnExamHostApi }).learnExams;
  const [exams, setExams] = useState<LearnExamView[]>([]);
  const [error, setError] = useState("");
  const [grading, setGrading] = useState(false);
  const gradingRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    async function load() {
      try { const values = await api?.list(conversationId); if (!disposed) { setExams(values ?? []); setError(""); } }
      catch (error) { if (!disposed) setError(String(error)); }
    }
    const off = api?.onChanged((event) => { if (event.conversationId === conversationId) void load(); });
    setExams([]);
    void load();
    return () => { disposed = true; off?.(); };
  }, [api, conversationId]);
  return <section className="cy-learn-exams" aria-label="学习试卷">
    <LearnStudyPanel key={conversationId} conversationId={conversationId} busy={busy} />
    {error && <p role="alert">{error}</p>}
    {exams.map((exam) => <div key={exam.examId}>
      <span>{exam.title} · {exam.status === "draft" ? "作答中" : exam.status === "graded" ? "已批改" : exam.status === "grading" ? "批改中" : "已交卷，待批改"}</span>
      <button type="button" onClick={() => void api?.open(conversationId, exam.examId).catch((error) => setError(String(error)))}>打开试卷</button>
      {(exam.status === "submitted" || exam.status === "grading_failed") && <button type="button" disabled={busy || grading} onClick={async () => {
        if (gradingRef.current || busy || !api) return;
        gradingRef.current = true; setGrading(true);
        let started = false;
        try {
          const result = await api.beginGrading(conversationId, exam.examId);
          if (!result.ok) throw new Error("无法开始批改");
          started = true;
          await onGrade(exam);
        } catch (error) { setError(String(error)); }
        finally {
          // An unfinished/failed/cancelled model run remains explicitly retryable.
          if (started) await api.finishGrading(conversationId, exam.examId).catch((error) => setError(String(error)));
          gradingRef.current = false; setGrading(false);
        }
      }}>开始批改</button>}
    </div>)}
  </section>;
}
