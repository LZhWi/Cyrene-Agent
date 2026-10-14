"use strict";
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const OMIT = ['background','conversation','max_output_tokens','max_tool_calls','metadata','moderation','multi_agent','prompt','prompt_cache_retention','safety_identifier','temperature','top_logprobs','top_p','truncation','user','previous_response_id'];
function adapt(body, allowFunctions = false) {
  if (!body.model || !Array.isArray(body.input)) throw new Error('A model and full input history are required');
  const out = { ...body, stream: true, store: false };
  out.input = body.input.map(item => item.role === 'assistant' && Array.isArray(item.content)
    ? { ...item, content: item.content.map(block => block.type === 'input_text' ? { ...block, type: 'output_text' } : block) }
    : item);
  for (const key of OMIT) delete out[key];
  // Namespace forwarding requires host support for namespaced tool-call replay.
  // Reject tools when the caller has not enabled function-tool support.
  if (out.tools?.length) {
    if (!allowFunctions) throw new Error('Tool calls are not enabled for this request');
    if (out.tools.some(tool => tool.type !== 'function')) throw new Error('Only local function tools are enabled');
    out.input.unshift({ type: 'additional_tools', role: 'developer', tools: out.tools });
    delete out.tools;
  }
  return out;
}
async function readResponse(response) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = String(payload.error?.message || '').slice(0, 800);
    throw new Error(`Official Responses request failed (${response.status})${detail ? ': ' + detail : ''}`);
  }
  let pending = '', terminal, size = 0;
  const events = [];
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > 16 * 1024 * 1024) throw new Error('OAuth response exceeded 16 MiB');
    pending = (pending + decoder.decode(bytes, { stream: true })).replace(/\r\n/g, '\n');
    let index;
    while ((index = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, index); pending = pending.slice(index + 2);
      const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data); events.push(event);
      if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) throw new Error(`Official response did not complete (${event.type})`);
      if (event.type === 'response.completed') terminal = event.response;
    }
  }
  if (!terminal || terminal.status !== 'completed') throw new Error('Official stream ended without a completed response');
  // The plan route can omit output snapshots from the terminal envelope.
  // Preserve the canonical completed items carried by the stream itself.
  if (!terminal.output?.length) {
    terminal.output = events.filter(e => e.type === 'response.output_item.done' && e.item)
      .sort((a, b) => a.output_index - b.output_index).map(e => e.item);
  }
  return { terminal, events };
}
async function startProxy({ oauth, fetchImpl = fetch, allowFunctions = false, onRequest = () => {}, onResponse = () => {} }) {
  const secret = randomBytes(32).toString('hex');
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secret}` || req.headers.origin) { res.writeHead(403).end(); return; }
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 120000);
    res.on('close', () => controller.abort());
    try {
      if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
      const chunks = []; let size = 0;
      // A 20 MiB image needs about 27 MiB after base64 encoding, plus prompt text.
      for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error('Request too large (32 MiB limit)'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), wire = adapt(body, allowFunctions);
      onRequest(wire);
      const token = await oauth.accessToken();
      const upstream = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(wire),
      });
      // Buffer until terminal success: Cyrene's current simple LLM client ignores SSE error events.
      // Never let a partial/failed stream appear to that client as a successful answer.
      const { terminal, events } = await readResponse(upstream);
      onResponse(terminal, events);
      if (body.stream === false) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(terminal)); }
      else { res.setHeader('Content-Type', 'text/event-stream'); res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')); }
    } catch (e) { if (!res.destroyed) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } })); } }
    finally { clearTimeout(timer); controllers.delete(controller); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, secret,
    close: async () => { for (const c of controllers) c.abort(); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
module.exports = { adapt, readResponse, startProxy };
