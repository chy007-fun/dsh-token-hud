/**
 * dsh-token-hud 客户端冒烟测试：jsdom + 真实 React 渲染 client.js。
 * 用法：node test.client.mjs
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ---- jsdom 环境 ----
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
	url: 'http://127.0.0.1:3080/',
	pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---- mock 模块加载器与依赖 ----
const nodeRequire = createRequire(import.meta.url);
const react = nodeRequire('react');
const reactDomClient = nodeRequire('react-dom/client');
const jsxRuntime = nodeRequire('react/jsx-runtime');

const loaded = {};
globalThis.window.__ModuleLoader__ = {
	load({ id, factory }) {
		loaded[id] = factory((name) => {
			if (name === 'react') return react;
			if (name === 'react/jsx-runtime') return jsxRuntime;
			throw new Error('unexpected require: ' + name);
		});
	},
};

// fetch mock：可编程响应
let fetchImpl = async () => ({ ok: false, status: 500 });
globalThis.window.fetch = (url) => fetchImpl(url);
globalThis.fetch = globalThis.window.fetch;

// ---- 加载被测客户端 ----
const code = readFileSync(join(here, 'lib/client.js'), 'utf8');
// client.js 是浏览器脚本：在 jsdom 全局上 eval 执行
dom.window.eval(code);

const plugin = loaded['dsh-token-hud'];
if (!plugin) throw new Error('plugin not registered with __ModuleLoader__');
if (typeof plugin.apply !== 'function') throw new Error('apply missing');
if (JSON.stringify(plugin.inject) !== '["slots"]') throw new Error('inject mismatch: ' + JSON.stringify(plugin.inject));

// ---- fake ctx：捕获 shell.overlay 注册 ----
const effects = [];
const registrations = [];
const slotEntries = [];
const fakeCtx = {
	effect(fn, label) { effects.push({ fn, label }); },
	slots: {
		inject(slotName, register) {
			registrations.push(slotName);
			register(); // 立即声明可用，触发注册
		},
		register(meta, component) {
			slotEntries.push({ meta, component });
			return () => {};
		},
	},
};

plugin.apply(fakeCtx);

if (!registrations.includes('shell.overlay')) throw new Error('shell.overlay not injected');
const hudEntry = slotEntries.find((entry) => entry.meta.id === 'token-hud');
if (!hudEntry) throw new Error('token-hud entry not registered');
if (document.querySelector('style[data-plugin="dsh-token-hud"]') === null) throw new Error('styles not injected');

// 挂到真实 DOM
const container = document.createElement('div');
document.body.appendChild(container);
const root = reactDomClient.createRoot(container);
const Component = hudEntry.component;

// ---- 场景 1：API 全失败 → 5 次后显示“离线”胶囊 ----
fetchImpl = async () => { throw new Error('boom'); };
root.render(react.createElement(Component));
await new Promise((resolve) => setTimeout(resolve, 5500));
let html = container.innerHTML;
if (!html.includes('离线') && !html.includes('offline')) {
	// zh 环境判定取决于 jsdom navigator.language（en-US）→ 应显示 offline
	if (!html.toLowerCase().includes('offline')) throw new Error('offline pill missing after failures, html=' + html.slice(0, 200));
}
console.log('S1 离线降级 ✓');

// ---- 场景 2：API 正常 → 渲染 HUD，显示速度/输出/会话行 ----
const now = Date.now();
fetchImpl = async (url) => {
	if (!String(url).includes('/token-hud/v1/stats')) return { ok: false, status: 404 };
	return {
		ok: true, status: 200,
		json: async () => ({
			serverTime: now, windowMs: 5000,
			global: { tps: 31.4, running: 2, tracked: 2, outputTotal: 123456 },
			sessions: [
				{ id: 'sess-abc123def', status: 'streaming', tps: 28.1, turnOutput: 900, sessionOutput: 9000, turnMs: 30000, lastChunkAgeMs: 200, model: 'deepseek-v4-pro', provider: 'nionio2026' },
				{ id: 'sess-xyz789', status: 'retrying', tps: 0, turnOutput: 0, sessionOutput: 5000, turnMs: 12000, lastChunkAgeMs: null, model: null, provider: null },
			],
			models: [
				{ model: 'deepseek-v4-pro', provider: 'nionio2026', outputTokens: 4800, peakTps: 28.1 },
				{ model: 'glm-5.3', provider: 'nionio', outputTokens: 1200, peakTps: 45.0 },
			],
		}),
	};
};
root.render(react.createElement(Component));
await new Promise((resolve) => setTimeout(resolve, 1500));
html = container.innerHTML;
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT FAIL: ' + msg + '\nHTML: ' + html.slice(0, 400)); };
assert(html.includes('31.4'), 'global tps rendered');
assert(html.includes('tok/s'), 'tok/s unit rendered');
assert(html.includes('123.5K') || html.includes('123456'), 'output total formatted');
assert(html.includes('sess-a'), 'session short id rendered');
assert(html.includes('deepseek-v4-pro'), 'model rendered');
assert(html.includes('28.1'), 'per-session tps rendered');
assert(html.includes('th-streaming'), 'streaming dot class');
assert(html.includes('th-retrying'), 'retrying dot class');
// 模型聚合区：两行 ↑累计 + ⚡峰值
assert(html.includes('th-models'), 'models section rendered');
assert(html.includes('↑') && html.includes('⚡'), 'up-arrow and lightning icons present');
assert(html.includes('glm-5.3'), 'second model row rendered');
console.log('S2 正常渲染 ✓');

// ---- 场景 3：折叠 → 小胶囊 ----
const toggleBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '–');
assert(toggleBtn, 'collapse button found');
toggleBtn.click();
await new Promise((resolve) => setTimeout(resolve, 300));
html = container.innerHTML;
assert(html.includes('th-pill'), 'collapsed pill rendered');
assert(!html.includes('th-body'), 'body hidden when collapsed');
console.log('S3 折叠 ✓');

// ---- 场景 4：折叠状态持久化（重新挂载仍是折叠态）----
root.unmount();
await new Promise((resolve) => setTimeout(resolve, 100));
const container2 = document.createElement('div');
document.body.appendChild(container2);
const root2 = reactDomClient.createRoot(container2);
root2.render(react.createElement(Component));
await new Promise((resolve) => setTimeout(resolve, 1200));
assert(container2.innerHTML.includes('th-pill'), 'collapsed state persisted across remount');
root2.unmount();
console.log('S4 状态持久化 ✓');

// ---- 场景 5：空闲 → 灰点 ----
fetchImpl = async () => ({
	ok: true, status: 200,
	json: async () => ({
		serverTime: now, windowMs: 5000,
		global: { tps: 0, running: 0, tracked: 1, outputTotal: 42 },
		sessions: [{ id: 'sess-idle1', status: 'idle', tps: 0, turnOutput: 42, sessionOutput: 42, turnMs: null, lastChunkAgeMs: 20000, model: 'm', provider: 'p' }],
	}),
});
const container3 = document.createElement('div');
document.body.appendChild(container3);
const root3 = reactDomClient.createRoot(container3);
root3.render(react.createElement(Component));
await new Promise((resolve) => setTimeout(resolve, 1500));
// 折叠态被持久化了，重置回来
const expandBtn = [...container3.querySelectorAll('button')].find((b) => b.textContent === '□');
expandBtn?.click();
await new Promise((resolve) => setTimeout(resolve, 1300));
assert(container3.innerHTML.includes('th-idle'), 'idle dot class rendered');
root3.unmount();
console.log('S5 空闲状态 ✓');

console.log('\nALL CLIENT SMOKE TESTS PASSED ✓');
process.exit(0);
