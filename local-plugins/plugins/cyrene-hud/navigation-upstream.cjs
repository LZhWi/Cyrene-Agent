"use strict";
const MODES = ["chat", "work", "code", "learn"];
// Only these existing upstream UI endpoints are used. No generic IPC or model bridge.
function createUpstreamNavigation(invoke, send) {
  async function listSessions(mode) {
    if (!MODES.includes(mode)) throw Error("不支持的会话模式");
    const rows = await invoke("chats:list", { mode });
    if (!Array.isArray(rows)) throw Error("宿主未返回会话列表");
    return rows.filter(row => row.mode === mode)
      .map(row => ({ id: row.id, title: row.title, mode: row.mode }));
  }
  async function open(config) {
    const mode = config.avatarTarget;
    if (mode === "none") return { sessionId: null };
    if (mode === "settings") {
      try {
        if (await invoke("settings:request-switch-section") !== true) throw Error("宿主未接受设置窗口打开请求");
      } catch (error) {
        if (!/No handler registered for ['"]settings:request-switch-section['"]/.test(error.message || "") || typeof send !== "function") throw error;
        send("sidebar:open-settings");
      }
      return { sessionId: null };
    }
    if (!MODES.includes(mode)) throw Error("不支持的窗口目标");
    let id;
    if (config.avatarSession === "existing") {
      const session = (await listSessions(mode)).find(row => row.id === config.avatarSessionId);
      if (!session) throw Error("所选会话不存在或模式已改变，请重新选择");
      id = session.id;
    } else if (config.avatarSession === "new") {
      const session = await invoke("chats:create", { mode });
      if (!session?.id || session.mode !== mode) throw Error("宿主未创建所选模式的会话");
      id = session.id;
    } else throw Error("请选择已有会话或新建会话");
    if (await invoke("chats:open-in-react-window", id) !== true) throw Error("宿主未接受窗口打开请求");
    return { sessionId: id };
  }
  return { listSessions, open };
}
module.exports = { createUpstreamNavigation };
