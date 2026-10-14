import { IPC } from "../../shared/ipc-channels";
import type { LearnExamChangedEvent } from "../../shared/learn-exam";
import { parseLearnExamPageRequest } from "../protocols/learn-exam-page-protocol";

export interface ExamPageSource {
  id: number;
  getURL(): string;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

interface RegisteredSource {
  source: ExamPageSource;
  examId: string;
  conversationId: string;
}

const sources = new Map<number, RegisteredSource>();

export function registerExamPageSource(source: ExamPageSource, examId: string, conversationId: string): () => void {
  const entry = { source, examId, conversationId };
  sources.set(source.id, entry);
  return () => {
    if (sources.get(source.id) === entry) sources.delete(source.id);
  };
}

export function unregisterExamPageSource(sourceId: number): void {
  sources.delete(sourceId);
}

export function getTrustedExamPageSource(source: ExamPageSource): { examId: string; conversationId: string; source: ExamPageSource } | null {
  const entry = sources.get(source.id);
  if (!entry || entry.source !== source || source.isDestroyed()) return null;
  const page = parseLearnExamPageRequest(source.getURL());
  if (!page || page.kind !== "document" || page.examId !== entry.examId) return null;
  return entry;
}

export function publishLearnExamPageChanged(event: LearnExamChangedEvent): void {
  for (const entry of sources.values()) {
    if (entry.examId !== event.examId || entry.conversationId !== event.conversationId || entry.source.isDestroyed()) continue;
    entry.source.send(IPC.LEARN_EXAM_PAGE_CHANGED, event);
  }
}
