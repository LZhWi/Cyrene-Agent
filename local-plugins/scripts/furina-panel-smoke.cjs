// Standalone hidden Electron panel, synthetic model, and real local file API.
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const localRoot = path.resolve(__dirname, "..");
const testParent = path.join(localRoot, ".test-runtime", "furina-panel");
fs.mkdirSync(testParent, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(testParent, "run-"));
for (const name of ["userData", "sessionData", "logs", "crashDumps", "temp"]) {
  const directory = path.join(runRoot, name);
  fs.mkdirSync(directory); app.setPath(name, directory);
}
const python = process.env.FURINA_API_PYTHON;
const sourceRoot = process.env.FURINA_API_SOURCE;
const workspace = path.join(runRoot, "workspace");
fs.mkdirSync(workspace);
let context;
let window;
const watchdog = setTimeout(() => app.exit(124), 90_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(expression) {
  for (let count = 0; count < 200; count++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await sleep(100);
  }
  throw new Error(`Panel condition timed out: ${expression}`);
}

async function main() {
  if (!python || !sourceRoot) throw new Error("FURINA_API_PYTHON and FURINA_API_SOURCE are required");
  const fixture = spawnSync(python, ["-c", "import sys; from pathlib import Path; sys.path.insert(0,str(Path(sys.argv[1])/'.cyrene-runtime'/'python-packages')); from PIL import Image; Image.new('RGBA',(120,80),(255,0,0,0)).save(Path(sys.argv[2])/'test.png')", sourceRoot, workspace], { encoding: "utf8", windowsHide: true });
  assert.equal(fixture.status, 0, fixture.stderr);
  fs.writeFileSync(path.join(workspace, "网页.html"), '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial;background:#eef4ff;padding:24px}h1{color:#315db6}</style></head><body><h1>HTML 文件导出测试</h1><p>Furina HTML export</p><img src="test.png"></body></html>', "utf8");
  await app.whenReady();
  const { createMockPluginContext } = require("@playa0v0/cyrene-plugin-sdk/testing");
  let modelCalls = 0;
  context = createMockPluginContext({ pluginId: "furina-file-tools", deps: { llm: {
    generateText: async () => { throw new Error("Unexpected model request"); },
    runGoal: async (options) => {
      modelCalls++;
      assert.deepEqual(options.tools.map((tool) => tool.id), ["furina-file-tools_selected", "furina-file-tools_selected_status"]);
      await options.tools[0].execute({});
      await options.tools[0].execute({}); // A repeated call must not duplicate the job.
      let result;
      for (let count = 0; count < 300; count++) {
        result = JSON.parse(await options.tools[1].execute({}));
        if (["completed", "failed"].includes(result.status)) break;
        await sleep(50);
      }
      assert.equal(result.status, "completed", result.error);
      return { text: "已按你指定的操作处理完成。", terminal: { status: "success", externalEffectsMayContinue: false }, rounds: 2 };
    },
  } } });
  context.storage.rootDir = () => path.join(runRoot, "plugin-data");
  context.storage.set("connection", { sourceRoot, python });
  const register = context.registerIpc.bind(context);
  context.registerIpc = (name, handler) => {
    register(name, handler);
    ipcMain.handle(`plugin:furina-file-tools:${name}`, (event, ...args) => {
      if (window && event.sender !== window.webContents) throw new Error("Unexpected IPC sender");
      return handler(...args);
    });
  };
  context.onDispose(() => { for (const name of context.ipcChannels.keys()) ipcMain.removeHandler(`plugin:furina-file-tools:${name}`); });
  dialog.showOpenDialog = async (...args) => {
    const options = args.at(-1);
    return { canceled: false, filePaths: options.properties.includes("openDirectory") ? [workspace]
      : [path.join(workspace, options.filters[0].extensions.includes("html") ? "网页.html" : "test.png")] };
  };
  shell.showItemInFolder = (file) => { assert.ok(fs.existsSync(file)); };
  const directory = path.join(localRoot, "artifacts", "furina-file-tools");
  const plugin = require(path.join(directory, "index.cjs")).default;
  await plugin.register(context);
  window = new BrowserWindow({ show: false, width: 900, height: 1000,
    webPreferences: { preload: path.join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, partition: "furina-panel-smoke" } });
  const rendererErrors = [];
  window.webContents.on("console-message", (...args) => {
    const details = args[1];
    if (details && typeof details === "object" && details.level === "error") rendererErrors.push(details.message);
  });
  await window.loadFile(path.join(directory, "ui.html"));
  await window.webContents.executeJavaScript("document.getElementById('workspace-pick').click()");
  await waitFor("document.getElementById('workspace').textContent.includes('workspace')");
  await window.webContents.executeJavaScript("document.getElementById('files-pick').click()");
  await waitFor("!document.getElementById('direct').disabled");
  await window.webContents.executeJavaScript("document.getElementById('direct').click()");
  await waitFor("document.getElementById('status').textContent === '处理完成'");
  assert.equal(modelCalls, 0);
  const direct = await context.ipcChannels.get("ui")("state");
  assert.equal(direct.data.job.status, "completed");
  await window.webContents.executeJavaScript("document.querySelector('#artifacts button').click()");
  await waitFor("!document.getElementById('model').disabled");
  await window.webContents.executeJavaScript("document.getElementById('model').click()");
  await waitFor("document.getElementById('model-text').textContent.includes('指定') && !document.getElementById('model').disabled");
  const model = await context.ipcChannels.get("ui")("state");
  assert.equal(modelCalls, 1);
  assert.equal(model.data.job.status, "completed");
  assert.equal(model.data.model.error, "");
  assert.equal(fs.readdirSync(path.join(workspace, ".furinakit-output")).length, 2);
  const htmlCases = [];
  for (const [tool, method, button] of [
    ["html-to-pdf", "render", "direct"], ["html-to-image", "render", "model"],
    ["html-to-image", "extract", "direct"], ["html-to-pdf", "extract", "model"],
  ]) {
    await window.webContents.executeJavaScript(`document.getElementById('tool').value=${JSON.stringify(tool)}; document.getElementById('tool').dispatchEvent(new Event('change')); document.getElementById('html-method').value=${JSON.stringify(method)}; document.getElementById('html-method').dispatchEvent(new Event('change')); document.getElementById('html-wait').value='500'; document.getElementById('files-pick').click()`);
    await waitFor("document.getElementById('files').textContent.includes('网页.html') && !document.getElementById('direct').disabled");
    const before = await context.ipcChannels.get("ui")("state");
    await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(button)}).click()`);
    await waitFor("document.getElementById('status').textContent === '处理完成' && !document.getElementById('direct').disabled");
    const after = await context.ipcChannels.get("ui")("state");
    assert.notEqual(after.data.job.id, before.data.job.id);
    assert.equal(after.data.job.tool, tool);
    assert.equal(after.data.job.parameters.method, method);
    assert.equal(after.data.job.status, "completed", after.data.job.error);
    assert.equal(after.data.model.error, "");
    const artifact = fs.readFileSync(after.data.job.artifacts[0].path);
    assert.equal(tool === "html-to-pdf" ? artifact.subarray(0, 4).toString() : artifact.subarray(1, 4).toString(), tool === "html-to-pdf" ? "%PDF" : "PNG");
    htmlCases.push({ tool, method, button, status: after.data.job.status });
  }
  assert.equal(modelCalls, 3);
  assert.equal(fs.readdirSync(path.join(workspace, ".furinakit-output")).length, 6);
  assert.deepEqual(rendererErrors, []);
  await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await sleep(150);
  const shot = await window.webContents.capturePage();
  const screenshot = path.join(testParent, "panel.png");
  fs.writeFileSync(screenshot, shot.toPNG());
  fs.writeFileSync(path.join(testParent, "result.json"), JSON.stringify({ nativeElectron: true, directApiCompleted: true, syntheticModelCalls: modelCalls,
    syntheticModelApiCompleted: true, htmlCases, jobsCreated: 6, rendererErrors, screenshot, runRoot }, null, 2));
  console.log("Furina panel native smoke passed: direct API + selected tool via synthetic model; screenshot=" + screenshot);
}
main().then(async () => {
  window?.destroy(); await context?.dispose(); clearTimeout(watchdog); app.exit(0);
}).catch(async (error) => {
  console.error(error); window?.destroy(); await context?.dispose(); clearTimeout(watchdog); app.exit(1);
});
