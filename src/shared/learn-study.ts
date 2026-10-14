import type { QuizQuestionInput, PopQuizAnswerSubmission } from "./pop-quiz";

export type LearnQuestionKind = "review" | "transfer";
export interface LearnStudySource {
  file: string;
  contentHash: string;
  quote: string;
  heading?: string;
}
export interface LearnReviewAttempt {
  id: string;
  at: string;
  result: "correct" | "incorrect" | "pending_model";
  answer: unknown;
  feedback: string;
  grader: "local" | "model";
}
export interface LearnReviewItem {
  id: string;
  question: QuizQuestionInput;
  kind: LearnQuestionKind;
  source?: LearnStudySource;
  origin: "quiz" | "exam";
  attempts: LearnReviewAttempt[];
  streak: number;
  intervalDays: number;
  nextReviewAt?: string;
}
export interface LearnReviewView {
  id: string;
  question: string;
  type: QuizQuestionInput["type"];
  learningObjective: string;
  options: Array<{ id: string; label: string }>;
  kind: LearnQuestionKind;
  source?: LearnStudySource;
  sourceStatus: "current" | "stale" | "unverified";
  origin: "quiz" | "exam";
  attemptCount: number;
  lastResult: LearnReviewAttempt["result"];
  nextReviewAt?: string;
}
export interface LearnStudyOverview {
  workspaceId: string;
  reviews: LearnReviewView[];
  dueCount: number;
  pendingCount: number;
  weakTopics: Array<{ objective: string; incorrect: number; assessed: number }>;
  estimatedTopics: Array<{ topic: string; mastery: number }>;
}
export interface LearnVideoEntry { id: string; seconds: number; text: string; kind: "note" | "subtitle" }
export interface LearnVideo {
  id: string;
  file: string;
  entries: LearnVideoEntry[];
}
export interface LearnVideoView extends LearnVideo { url: string; workspaceId: string }
export interface LearnStudyHostApi {
  overview(conversationId: string): Promise<LearnStudyOverview>;
  answer(conversationId: string, workspaceId: string, itemId: string, attemptId: string, answer: PopQuizAnswerSubmission): Promise<{ result: LearnReviewAttempt["result"]; explanation: string }>;
  videos(conversationId: string): Promise<LearnVideoView[]>;
  chooseVideo(conversationId: string): Promise<LearnVideoView | null>;
  addVideoNote(conversationId: string, workspaceId: string, videoId: string, seconds: number, text: string): Promise<void>;
  importSubtitles(conversationId: string, workspaceId: string, videoId: string): Promise<void>;
  onWorkspaceChanged(callback: (conversationId: string) => void): () => void;
}
