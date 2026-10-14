const $ = id => document.getElementById(id);
let state, initial = true, catalogKey = '', taskKey = '', polling = false;
const labels = { submitting: '正在提交', inProgress: '执行中', waiting: '等待回答', cancelling: '取消中', completed: '已结束', failed: '失败', interrupted: '已取消', unknown: '状态待核对' };
const busy = task => ['submitting','inProgress','waiting','cancelling'].includes(task.status);
function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
async function invoke(action, data) { const result = await window.codexBridge.invoke(action, data); if (!result.ok) throw new Error(result.error); return result.data; }
async function action(name, data) { $('error').textContent = ''; try { return await invoke(name, data); } catch (error) { $('error').textContent = error.message; throw error; } }
function option(select, value, name) { const node = el('option', name); node.value = value; select.append(node); return node; }
function efforts() {
  const model = state.models.find(model => model.model === $('model').value), old = $('effort').value;
  $('effort').replaceChildren();
  for (const effort of model?.supportedReasoningEfforts ?? []) option($('effort'), effort.reasoningEffort, effort.reasoningEffort);
  if ([...$('effort').options].some(option => option.value === old)) $('effort').value = old;
  else if (model) $('effort').value = model.defaultReasoningEffort;
}
function skillDescription() { $('skillDescription').textContent = state.skills.find(skill => skill.path === $('skill').value)?.description ?? ''; }
function button(text, run) { const node = el('button', text); node.type = 'button'; node.onclick = async () => { node.disabled = true; try { await run(); await refresh(); } catch {} finally { node.disabled = false; } }; return node; }
function renderPrompt(prompt) {
  const box = el('div', undefined, 'prompt');
  if (prompt.method === 'item/tool/requestUserInput') {
    box.append(el('strong', 'Codex 需要你的回答'));
    const inputs = {};
    for (const q of prompt.params.questions) {
      box.append(el('p', q.question));
      const field = el('input'); field.type = q.isSecret ? 'password' : 'text'; field.placeholder = '选择上方选项或输入回答'; inputs[q.id] = field;
      for (const o of q.options ?? []) { const pick = button(o.label, async () => { field.value = o.label; }); pick.title = o.description; box.append(pick); }
      box.append(field);
    }
    box.append(button('提交回答', () => action('answer', { taskId: prompt.taskId, requestId: prompt.id,
      answers: Object.fromEntries(Object.entries(inputs).map(([id, field]) => [id, field.value])) })));
  } else {
    box.append(el('strong', 'Codex 请求操作授权'));
    box.append(el('pre', JSON.stringify(prompt.params, null, 2)));
    const offered = prompt.params.availableDecisions ?? ['accept','decline','cancel'];
    for (const [decision, title] of [['accept','允许此次'],['decline','拒绝'],['cancel','取消']]) {
      if (offered.includes(decision)) box.append(button(title, () => action('answer', { taskId: prompt.taskId, requestId: prompt.id, decision })));
    }
  }
  return box;
}
function renderTasks() {
  // Retain the pending form DOM while streaming, so user input is never erased by polling.
  const key = JSON.stringify({ tasks: state.tasks.map(({ progress, ...task }) => task), prompts: state.prompts });
  if (key === taskKey) { for (const task of state.tasks) { const p = document.querySelector(`[data-progress="${task.id}"]`); if (p) p.textContent = task.progress; } return; }
  taskKey = key;
  const drafts = new Map([...document.querySelectorAll('.prompt input')].map(node => [node.dataset.key, node.value]));
  $('tasks').replaceChildren();
  if (!state.tasks.length) $('tasks').append(el('div', '还没有任务。消息和配置将直接提交给 Codex。', 'empty'));
  for (const task of state.tasks) {
    const card = el('article', undefined, 'task'), head = el('div', undefined, 'task-head');
    head.append(el('strong', new Date(task.createdAt).toLocaleString()), el('span', labels[task.status] ?? task.status, 'badge'));
    card.append(head, el('p', `${task.config.model} · ${task.config.effort} · ${task.config.sandbox}`, 'meta'), el('pre', task.message));
    if (task.threadId) card.append(el('p', `Codex 会话：${task.threadId}`, 'meta'));
    const progress = el('pre', task.progress, 'progress'); progress.dataset.progress = task.id; card.append(progress);
    for (const prompt of state.prompts.filter(prompt => prompt.taskId === task.id)) {
      const box = renderPrompt(prompt);
      [...box.querySelectorAll('input')].forEach((node, index) => { node.dataset.key = `${task.id}:${prompt.id}:${index}`; if (drafts.has(node.dataset.key)) node.value = drafts.get(node.dataset.key); });
      card.append(box);
    }
    if (task.error) card.append(el('p', task.error, 'error'));
    if (task.finalText) { card.append(el('h3', 'Codex 原始回执'), el('pre', task.finalText)); }
    if (task.diff) { const details = el('details'); details.append(el('summary', '查看文件变化'), el('pre', task.diff)); card.append(details); }
    if (task.explanation || task.explaining || task.explanationError) { const reply = el('div', undefined, 'explanation'); reply.append(el('strong', 'Cyrene 解读'), el('pre', task.explaining ? '正在生成回复…' : task.explanation ?? task.explanationError)); card.append(reply); }
    const actions = el('div', undefined, 'actions');
    if (busy(task) && task.turnId) actions.append(button('取消任务', () => action('cancel', { id: task.id })));
    if (task.status === 'unknown') actions.append(button('核对回执', () => action('sync', { id: task.id })));
    if (task.finalText && !task.explaining && !busy(task)) actions.append(button('由 Cyrene 解读', () => action('explain', { id: task.id })));
    card.append(actions); $('tasks').append(card);
  }
  const previous = $('continuation').value;
  $('continuation').replaceChildren(); option($('continuation'), '', '创建新任务');
  for (const task of state.tasks.filter(task => ['completed','failed','interrupted'].includes(task.status) && task.threadId && task.config.cwd === state.config.cwd)) option($('continuation'), task.id, `继续：${task.message.slice(0,35)}`);
  if ([...$('continuation').options].some(option => option.value === previous)) $('continuation').value = previous;
}
async function refresh() {
  if (polling) return; polling = true;
  try {
    state = await invoke('state');
    if (initial) { for (const id of ['executable','cwd','sandbox']) $(id).value = state.config[id]; $('autoExplain').checked = state.config.autoExplain; initial = false; }
    $('connection').textContent = state.connection === 'idle' ? '会话已释放 · 下次提交自动连接' : state.connection === 'releasing' ? '正在释放会话…' : state.connection === 'connected' ? `已连接 · ChatGPT ${state.account?.planType ?? ''}` : state.connection === 'connecting' ? '正在连接…' : state.connectionError || '尚未连接';
    const key = JSON.stringify([state.models,state.skills,state.config.cwd]);
    if (key !== catalogKey) {
      catalogKey = key; const oldModel = $('model').value || state.config.model, oldSkill = $('skill').value || state.config.skillPath;
      $('model').replaceChildren(); for (const model of state.models) option($('model'), model.model, model.displayName || model.model);
      $('model').value = state.models.some(m => m.model === oldModel) ? oldModel : state.models.find(m => m.isDefault)?.model ?? state.models[0]?.model ?? '';
      efforts(); if (state.config.effort && [...$('effort').options].some(o => o.value === state.config.effort)) $('effort').value = state.config.effort;
      $('skill').replaceChildren(); option($('skill'), '', '不指定技能');
      for (const skill of state.skills) { const o = option($('skill'), skill.path, `${skill.name}${skill.enabled ? '' : '（已停用）'}`); o.disabled = !skill.enabled; }
      if (state.skills.some(s => s.path === oldSkill && s.enabled)) $('skill').value = oldSkill;
      skillDescription();
      if (state.skillErrors.length) $('error').textContent = `部分技能加载失败：${state.skillErrors.map(e => e.message).join('；')}`;
    }
    const active = state.tasks.some(busy), connecting = ['connecting','releasing'].includes(state.connection);
    $('connect').disabled = active || connecting; $('executable').disabled = active || connecting; $('cwd').disabled = active || connecting;
    for (const id of ['model','effort','skill']) $(id).disabled = !['connected','idle'].includes(state.connection);
    $('submit').disabled = !['connected','idle'].includes(state.connection) || active || state.tasks.some(t => t.status === 'unknown');
    renderTasks();
  } catch (error) { $('error').textContent = error.message; } finally { polling = false; }
}
$('model').onchange = efforts; $('skill').onchange = skillDescription;
$('connect').onclick = async () => { $('connect').disabled = true; try { await action('connect', { ...state.config, executable: $('executable').value.trim(), cwd: $('cwd').value.trim(), sandbox: $('sandbox').value, autoExplain: $('autoExplain').checked }); } catch {} await refresh(); };
$('submit').onclick = async () => {
  if ($('cwd').value.trim() !== state.config.cwd || $('executable').value.trim() !== state.config.executable) { $('error').textContent = '连接路径已更改，请先重新连接。'; return; }
  $('submit').disabled = true;
  try { await action('submit', { message: $('message').value, model: $('model').value, effort: $('effort').value, skillPath: $('skill').value, sandbox: $('sandbox').value, autoExplain: $('autoExplain').checked, continueId: $('continuation').value || undefined }); $('message').value = ''; } catch {}
  await refresh();
};
void refresh(); const interval = setInterval(refresh, 700); window.addEventListener('beforeunload', () => clearInterval(interval));
