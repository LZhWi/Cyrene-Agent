'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { transformSync } = require('esbuild');
const root = path.resolve(__dirname, '../../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function commonjs(file, require) {
  const exports = {};
  const code = transformSync(read(file), { loader: 'ts', format: 'cjs', target: 'node24' }).code;
  const module = { exports };
  new Function('require', 'module', 'exports', code)(require, module, exports);
  return module.exports;
}
test('real host and official bridge: first load works, stale-host remount fails closed', async () => {
  const dom = new JSDOM('<div id="plugin-panels-plugins" class="plugin-panels"></div>', { url: 'https://host.test/settings', runScripts: 'outside-only' });
  const win = dom.window, requests = [];
  const protocol = commonjs('src/renderer/settings/panel-bridge-protocol.ts');
  win.plugins = { list: async () => [{ id: 'minecraft-body', name: 'MC', version: '0.4.1', settingsPanel: 'settings.html', enabled: true }] };
  win.pluginPanel = { invoke: async (id, channel, args) => {
    requests.push({ id, channel, args });
    return { ok: true, data: channel === 'body-status' ? { running: true, starting: false, state: { connected: true, health: 20, food: 20 }, results: [] } : null };
  } };
  const hostCode = transformSync(read('src/renderer/settings/plugin-panels.ts'), { loader: 'ts', format: 'cjs', target: 'node24' }).code;
  win.module = { exports: {} }; win.exports = win.module.exports; win.require = () => protocol;
  win.eval(hostCode);
  const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
  const children = [];
  try {
    for (let round = 0; round < 2; round++) {
      await win.module.exports.mountPluginPanels();
      const iframe = [...win.document.querySelectorAll('iframe')].at(-1);
      const child = iframe.contentWindow; children.push(child);
      child.document.write(read('local-plugins/plugins/minecraft-body/static/settings.html'));
      child.postMessage = data => queueMicrotask(() => child.dispatchEvent(new child.MessageEvent('message', { data, source: win, origin: 'https://host.test' })));
      win.postMessage = data => queueMicrotask(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: child, origin: 'cyrene-plugin://minecraft-body' })));
      child.eval(read('src/main/plugin-panel/panel-bridge.js'));
      child.eval(read('local-plugins/plugins/minecraft-body/static/settings.js'));
      await flush();
      assert.equal(requests.length, round * 2, 'no RPC before actual host load registration');
      assert.equal(child.document.getElementById('execute').disabled, true);
      iframe.dispatchEvent(new win.Event('load'));
      await flush();
      if (round === 0) {
        assert.equal(requests.length, 2);
        assert.equal(requests.at(-2).channel, 'body-status');
        assert.equal(requests.at(-1).channel, 'task-status');
        assert.equal(child.document.getElementById('execute').disabled, false);
        assert.equal(child.document.getElementById('task-state').textContent, '尚无高层任务');
      } else {
        // Host leaves the removed iframe in panelRegistry and routes this reply
        // there. Plugin-only code cannot repair that host-owned map; fail closed.
        assert.equal(requests.length, 3);
        await new Promise(resolve => setTimeout(resolve, 5100));
        assert.match(child.document.getElementById('summary').textContent, /请求超时/);
        assert.equal(child.document.getElementById('execute').disabled, true);
        assert.equal(child.document.getElementById('task-ack').disabled, true);
      }
      child.dispatchEvent(new child.Event('pagehide'));
      iframe.parentElement.remove();
    }
  } finally {
    for (const child of children) { try { child.close(); } catch {} }
    win.close();
  }
});
