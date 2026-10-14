import { expect, it, vi } from 'vitest';
import { runProactiveStages, sameProactiveModel } from './proactive-stages';
const model = { provider: 'test', baseUrl: 'https://example.invalid', apiKey: 'fixture', model: 'model' };
it('compares actual configuration including effort, not object identity', () => {
  expect(sameProactiveModel(model, { ...model })).toBe(true);
  expect(sameProactiveModel(model, { ...model, reasoning: { mode: 'auto' } })).toBe(true);
  expect(sameProactiveModel(model, { ...model, model: 'other' })).toBe(false);
  expect(sameProactiveModel(model, { ...model, reasoning: { mode: 'on', effort: 'high' } })).toBe(false);
});
it('keeps the original single request unchanged for equal configurations', async () => {
  const generate = vi.fn(async () => '{"decision":"send","text":"hello"}');
  expect(await runProactiveStages(true, generate)).toContain('hello');
  expect(generate).toHaveBeenCalledExactlyOnceWith('content');
});
it.each(['{"decision":"silent"}', 'invalid', '{"decision":"unknown"}', '[]'])('does not generate content after %s', async raw => {
  const generate = vi.fn(async () => raw); await runProactiveStages(false, generate);
  expect(generate).toHaveBeenCalledTimes(1); expect(generate.mock.calls[0][0]).toBe('decision');
});
it('only passes original context plus a trusted instruction to content after approval', async () => {
  const generate = vi.fn().mockResolvedValueOnce('{"decision":"send","text":"untrusted draft"}').mockResolvedValueOnce('{"decision":"send","text":"hello"}');
  expect(await runProactiveStages(false, generate)).toContain('hello');
  expect(generate.mock.calls.map(call => call[0])).toEqual(['decision', 'content']);
  expect(generate.mock.calls[1][1]).not.toContain('untrusted draft');
});
it('stops after failed or cancelled judgment', async () => {
  const failed = vi.fn().mockRejectedValue(new Error('failed'));
  await expect(runProactiveStages(false, failed)).rejects.toThrow('failed'); expect(failed).toHaveBeenCalledTimes(1);
  const control = new AbortController(); const cancelled = vi.fn(async () => { control.abort(); return '{"decision":"send"}'; });
  await expect(runProactiveStages(false, cancelled, control.signal)).rejects.toThrow(); expect(cancelled).toHaveBeenCalledTimes(1);
});
