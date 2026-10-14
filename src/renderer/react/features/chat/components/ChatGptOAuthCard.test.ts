// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChatGptOAuthCard } from './ChatGptOAuthCard';
import { CHATGPT_OAUTH_URL } from '../../../../../shared/chatgpt-oauth';
it('loads the fixed saved profile without writes, then saves only on request', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const save = vi.fn(async () => ({ added: true })), onSaved = vi.fn(async () => {});
  (window as any).settings = {
    listModelProfiles: async () => ({ profiles: [{ baseUrl: CHATGPT_OAUTH_URL, model: 'saved-model', displayName: '我的 OAuth' }] }),
    chatGptOAuthStatus: async () => ({ connected: true, planEnabled: true }),
    chatGptOAuthSave: save,
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(ChatGptOAuthCard, { onSaved })));
    expect(container.textContent).toContain('不可移除');
    expect(container.querySelector('select')?.value).toBe('saved-model');
    expect(container.querySelector('input')?.value).toBe('我的 OAuth');
    expect(save).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === '保存 OAuth 档案')!.click());
    expect(save).toHaveBeenCalledWith({ model: 'saved-model', displayName: '我的 OAuth' });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('当前主模型未改变');
  } finally { await act(async () => root.unmount()); container.remove(); delete (window as any).settings; vi.unstubAllGlobals(); }
});
