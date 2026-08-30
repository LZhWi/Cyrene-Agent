import { PlanContent, planTabDotClass, planTabLabel, type PlanReviewPhase } from "./PlanReviewPanel";
import { ReviewDiffContent } from "./ReviewInspector";
import { RightInspector, type InspectorTab } from "./RightInspector";

export type ChatPageInspectorTabId = "diff" | "plan";

export interface ChatPageInspectorProps {
  reviewInspector: { runId: string; fileIndex: number } | null;
  activePlan: { content: string; phase: PlanReviewPhase } | null;
  planDrawerOpen: boolean;
  activeTabId: ChatPageInspectorTabId;
  onTabChange: (id: ChatPageInspectorTabId) => void;
  onCloseTab: (id: ChatPageInspectorTabId) => void;
}

export function ChatPageInspector({
  reviewInspector,
  activePlan,
  planDrawerOpen,
  activeTabId,
  onTabChange,
  onCloseTab,
}: ChatPageInspectorProps) {
  const tabs: InspectorTab[] = [];
  if (reviewInspector) {
    tabs.push({
      id: "diff",
      label: "Diff",
      content: <ReviewDiffContent runId={reviewInspector.runId} fileIndex={reviewInspector.fileIndex} />,
    });
  }
  if (activePlan && planDrawerOpen) {
    tabs.push({
      id: "plan",
      label: planTabLabel(activePlan.phase),
      dotClass: planTabDotClass(activePlan.phase),
      content: <PlanContent content={activePlan.content} phase={activePlan.phase} />,
    });
  }
  if (tabs.length === 0) return null;

  return (
    <RightInspector
      tabs={tabs}
      activeTabId={activeTabId}
      onTabChange={(id) => onTabChange(id as ChatPageInspectorTabId)}
      onClose={() => onCloseTab(activeTabId)}
    />
  );
}
