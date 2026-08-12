// API 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const apiForm = document.getElementById("api-form") as HTMLFormElement;
export const apiRuntimeForm = document.getElementById("api-runtime-form") as HTMLFormElement;
export const presetCards = document.getElementById("preset-cards") as HTMLElement;
export const presetWebsiteLink = document.getElementById("preset-website-link") as HTMLAnchorElement;
export const displayNameInput = document.getElementById("display-name") as HTMLInputElement;
export const baseUrlInput = document.getElementById("base-url") as HTMLInputElement;
export const baseUrlResetBtn = document.getElementById("base-url-reset-btn") as HTMLButtonElement;
export const modelInput = document.getElementById("model-input") as HTMLInputElement;
export const modelInputSuggestions = document.getElementById("model-input-suggestions") as HTMLDataListElement;
export const contextWindowInput = document.getElementById("context-window-input") as HTMLInputElement;
export const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
export const apiKeyLabel = document.getElementById("api-key-label") as HTMLElement;
export const apiKeyHint = document.getElementById("api-key-hint") as HTMLElement;
export const testConnectionBtn = document.getElementById("test-connection-btn") as HTMLButtonElement | null;
export const transportSelect = document.getElementById("transport-select") as HTMLSelectElement;
export const transportHint = document.getElementById("transport-hint") as HTMLElement;
export const endpointPreview = document.getElementById("endpoint-preview") as HTMLElement;
export const customEndpointControls = document.getElementById("custom-endpoint-controls") as HTMLElement;
export const customEndpointOverrides = document.getElementById("custom-endpoint-overrides") as HTMLElement;
export const customEndpointSummary = document.getElementById("custom-endpoint-summary") as HTMLElement;
export const customEndpointGuideBtn = document.getElementById("custom-endpoint-guide-btn") as HTMLButtonElement;
export const workFlowAdaptBtn = document.getElementById("work-flow-adapt-btn") as HTMLButtonElement | null;
export const apiNoteText = document.getElementById("api-note-text") as HTMLElement;
export const multimodalToggle = document.getElementById("multimodal-toggle") as HTMLInputElement;
export const chatRequestTimeoutSecInput = document.getElementById("chat-request-timeout-sec") as HTMLInputElement;
export const embeddingDimensionsInput = document.getElementById("embedding-dimensions-input") as HTMLInputElement | null;
export const modelRequestTimeoutSecInput = document.getElementById("model-request-timeout-sec") as HTMLInputElement;
export const modelRequestTimeoutSecReset = document.getElementById("model-request-timeout-sec-reset-btn") as HTMLButtonElement;
export const toggleEnableThinking = document.getElementById("toggle-enable-thinking") as HTMLInputElement;
export const toggleDisableThinking = document.getElementById("toggle-disable-thinking") as HTMLInputElement;
export const toggleDisableMaxToken = document.getElementById("toggle-disable-max-token") as HTMLInputElement;
