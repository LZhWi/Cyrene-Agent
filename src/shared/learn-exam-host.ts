import type { LearnExamCreatedEvent, LearnExamView } from "./learn-exam";

export interface LearnExamHostApi {
  list(conversationId: string): Promise<LearnExamView[]>;
  open(conversationId: string, examId: string): Promise<{ ok: boolean }>;
  beginGrading(conversationId: string, examId: string): Promise<{ ok: boolean }>;
  finishGrading(conversationId: string, examId: string): Promise<{ ok: boolean }>;
  onChanged(callback: (event: LearnExamCreatedEvent) => void): () => void;
}
