/**
 * dsh-token-hud host 半边的最小功能测试（无 DSH 宿主直接跑 apply）。
 * 用法：node test.mjs
 */
import { apply } from './lib/index.js';

// ---- fake ctx ----
const handlers = [];
const effects = [];
const routes = [];
const warnings = [];
const ctx = {
	on(name, fn) { if (name === 'session/event') handlers.push(fn); },
	effect(fn, label) { effects.push({ fn, label }); },
	logger: { warn: (e) => warnings.push(String(e?.message ?? e)) },
	webServer: { register: (route) => routes.push(route) },
};

apply(ctx, { apiPath: '/token-hud/v1' });
for (const effect of effects) effect.fn();

if (handlers.length !== 1) throw new Error('expected one session/event handler');
if (routes.length !== 1) throw new Error('expected one webServer route');
const route = routes[0];
if (route.path !== '/token-hud/v1') throw new Error('route path mismatch: ' + route.path);

const fire = (session, event) => handlers[0](session, event);
const sid = { id: 'sess-abc123' };
let t = Date.now() - 1000; // 从真实“现在”往前 1 秒开始，保证 TPS 窗口有效
const ev = (type, data, dt = 0) => ({ type, data, time: (t += dt) });

// 一轮：turn/start → chunk×3 → message(usage 精确 300) → tool → turn/end
fire(sid, ev('turn/start', { turn: 1 }));
fire(sid, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'a'.repeat(400) } }, 100));
fire(sid, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '中'.repeat(50) } }, 100));
fire(sid, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'tool-call-delta', argumentsDelta: 'x'.repeat(80) } }, 100));
fire(sid, ev('assistant/message', { turn: 1, step: 1, usage: { outputTokens: 300 }, message: { source: { provider: 'p', model: 'm' } } }, 100));
fire(sid, ev('tool/call', { callId: 'c1' }, 10));
fire(sid, ev('turn/end', { turn: 1 }, 10));

// 第二轮进行中（流式）
fire(sid, ev('turn/start', { turn: 2 }, 500));
fire(sid, ev('assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', text: 'b'.repeat(200) } }, 100));

// ---- 快照断言 ----
const fakeRes = (() => {
	const chunks = [];
	return {
		chunks, headers: null, status: null,
		writeHead(code, headers) { this.status = code; this.headers = headers; },
		end(body) { if (body) chunks.push(body); },
	};
})();
route.handler({ method: 'GET', url: '/token-hud/v1/stats' }, fakeRes);
const snap = JSON.parse(fakeRes.chunks.join(''));

const assert = (cond, msg) => { if (!cond) { console.error('SNAPSHOT:', JSON.stringify(snap, null, 2)); throw new Error('ASSERT FAIL: ' + msg); } };

assert(snap.global.tracked === 1, 'one tracked session');
// 轮1: 400/4=100 + 50CJK=50 + 80/4=20 = 170 估算 → usage 300 → 校正 +130 → 300
// 轮2: 200/4=50
assert(snap.sessions[0].sessionOutput === 350, `sessionOutput 350, got ${snap.sessions[0].sessionOutput}`);
assert(snap.sessions[0].turnOutput === 50, `turnOutput 50, got ${snap.sessions[0].turnOutput}`);
assert(snap.sessions[0].status === 'streaming', `status streaming, got ${snap.sessions[0].status}`);
assert(snap.sessions[0].model === 'm', 'model captured');
assert(snap.global.running === 1, 'one running session');
assert(snap.global.outputTotal === 350, `outputTotal 350, got ${snap.global.outputTotal}`);
// tps: 最近 5000ms 窗口内的样本（150/4≈37.5 的轮1末样本 + 50 轮2）都落在窗口内
assert(snap.sessions[0].tps > 0, 'tps positive');

// HEAD / 405 / 404
route.handler({ method: 'POST', url: '/token-hud/v1/stats' }, { writeHead() {}, end() {} });
route.handler({ method: 'GET', url: '/other' }, { writeHead() {}, end() {} });

if (warnings.length > 0) throw new Error('unexpected warnings: ' + warnings.join('; '));

console.log('ALL HOST TESTS PASSED ✓  (sessionOutput=350, turnOutput=50, tps=' + snap.sessions[0].tps + ', status=' + snap.sessions[0].status + ')');
