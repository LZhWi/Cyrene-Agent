import { describe, expect, it } from "vitest";
import { openPrimaryWindow } from "./primary-window";

describe("openPrimaryWindow", () => {
  it("opens the chat window instead of showing the pet window", () => {
    const state = { chatOpened: false, petShown: false };

    openPrimaryWindow({
      openChatWindow: () => {
        state.chatOpened = true;
      },
      showPetWindow: () => {
        state.petShown = true;
      },
    });

    expect(state).toEqual({ chatOpened: true, petShown: false });
  });
});
