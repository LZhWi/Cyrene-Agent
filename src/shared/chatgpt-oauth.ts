// Persist a route identifier, never an OAuth token or an ephemeral proxy address.
export const CHATGPT_OAUTH_URL = "https://chatgpt-oauth.invalid/v1";
export const CHATGPT_OAUTH_PROVIDER = "ChatGPT（OAuth）";
export const isChatGptOAuth = (config: { baseUrl?: string }) => config.baseUrl === CHATGPT_OAUTH_URL;
