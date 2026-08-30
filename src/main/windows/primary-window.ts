export interface PrimaryWindowActions {
  openChatWindow(): void;
  showPetWindow(): void;
}

/** The chat window is Cyrene's primary user-facing window. */
export function openPrimaryWindow(actions: PrimaryWindowActions): void {
  actions.openChatWindow();
}
