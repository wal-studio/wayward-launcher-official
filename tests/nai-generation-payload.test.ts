import assert from 'node:assert/strict';
import type { Config } from '../app/src/main/assets/imagegen-backend/wayward-imagegen/src/config.ts';
import {
  NovelAI_이미지생성하기,
  NovelAI_생성해시만들기,
  NovelAI_프롬프트만들기,
} from '../app/src/main/assets/imagegen-backend/wayward-imagegen/src/nai/client.ts';

const config = {
  naiToken: 'test-token-not-a-real-secret',
  naiModel: 'nai-diffusion-5-full',
  naiWidth: 832,
  naiHeight: 1216,
  naiSteps: 28,
  naiScale: 6.5,
  naiSampler: 'k_euler_ancestral',
  naiNoiseSchedule: 'karras',
  naiCommonPrompt: 'user common style',
  naiArtistPrompt: 'user artist tags',
  naiNegativePrompt: 'user common negative',
} as unknown as Config;

const png = Buffer.from([137,80,78,71,13,10,26,10]);
const originalFetch = globalThis.fetch;
let capturedUrl = '';
let capturedInit: RequestInit | undefined;
globalThis.fetch = async (input, init) => {
  capturedUrl = String(input);
  capturedInit = init;
  return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
};

try {
  const prompts = NovelAI_프롬프트만들기(config, 'game character and scene tags', 'game negative tags');
  assert.equal(prompts.prompt, 'user common style, user artist tags, game character and scene tags');
  assert.equal(prompts.negativePrompt, 'user common negative, game negative tags');
  const result = await NovelAI_이미지생성하기(config, prompts.prompt, prompts.negativePrompt, 305419896);
  assert.equal(capturedUrl, 'https://image.novelai.net/ai/generate-image');
  assert.equal(capturedInit?.method, 'POST');
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer test-token-not-a-real-secret');
  assert.equal(headers['Content-Type'], 'application/json');
  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.input, prompts.prompt);
  assert.equal(body.model, config.naiModel);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'naiToken'), false);
  const p = body.parameters;
  assert.equal(p.width, config.naiWidth);
  assert.equal(p.height, config.naiHeight);
  assert.equal(p.steps, config.naiSteps);
  assert.equal(p.scale, config.naiScale);
  assert.equal(p.sampler, config.naiSampler);
  assert.equal(p.noise_schedule, config.naiNoiseSchedule);
  assert.equal(p.seed, 305419896);
  assert.equal(p.negative_prompt, prompts.negativePrompt);
  assert.equal(p.v4_prompt.caption.base_caption, prompts.prompt);
  assert.equal(p.v4_negative_prompt.caption.base_caption, prompts.negativePrompt);
  assert.equal(p.n_samples, 1);
  assert.equal(result.seed, 305419896);
  assert.deepEqual(result.bytes, png);
  const first = NovelAI_생성해시만들기(config, prompts.prompt, prompts.negativePrompt, 1);
  const second = NovelAI_생성해시만들기(config, prompts.prompt, prompts.negativePrompt, 2);
  assert.notEqual(first, second, 'different user-selected seeds must not collide in the image cache');
  console.log('Mocked NAI payload test passed: user prompt, negative prompt, model, dimensions, steps, CFG, sampler, noise schedule and seed are applied.');
} finally {
  globalThis.fetch = originalFetch;
}
