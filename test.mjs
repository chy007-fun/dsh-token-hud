/**
 * dsh-token-hud host 半边的最小功能测试（无 DSH 宿主直接跑 apply）。
 * 覆盖三条路径：
 *   A. 旧宿主（0.1.2-rc.x）：session/event 的 assistant/chunk 逐 delta 估算
 *   B. 新宿主（0.1.5-rc.2+，format v2）：agent/assistant-stream 帧通道估算
 *   C. 双通道防双计：见到帧后旧通道的 chunk 一律忽略
 * 用法：node test.mjs
 */
import { apply } from './lib/index.js';

// ---- fake ctx ----
const handlers = new Map(); // name -> fn
const effects = [];
const routes = [];
const warnings = [];
const ctx = {
	on(name, fn) { handlers.set(name, fn); },
	effect(fn, label) { effects.push({ fn, label }); },
	logger: { warn: (e) => warnings.push(String(e?.message ?? e)) },
	webServer: { register: (route) => routes.push(route) },
};

apply(ctx, { apiPath: '/token-hud/v1' });
for (const effect of effects) effect.fn();

const sessionHandler = handlers.get('session/event');
const frameHandler = handlers.get('agent/assistant-stream');
if (typeof sessionHandler !== 'function') throw new Error('session/event handler missing');
if (typeof frameHandler !== 'function') throw new Error('agent/assistant-stream handler missing');
if (routes.length !== 1) throw new Error('expected one webServer route');
if (routes[0].path !== '/token-hud/v1') throw new Error('route path mismatch: ' + routes[0].path);

const fire = (session, event) => sessionHandler(session, event);
const emitFrame = (sessionId, frame) => frameHandler({ agent: { session: { id: sessionId } }, frame });

// ---- A. 旧宿主路径：assistant/chunk 走 session/event ----
const oldSid = { id: 'sess-old' };
let t = Date.now() - 1000;
const ev = (type, data, dt = 0) => ({ type, data, time: (t += dt) });

fire(oldSid, ev('turn/start', { turn: 1 }));
fire(oldSid, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'a'.repeat(400) } }, 100));
fire(oldSid, ev('assistant/message', { turn: 1, step: 1, usage: { outputTokens: 300 }, message: { source: { provider: 'p', model: 'm' } } }, 100));
fire(oldSid, ev('turn/end', { turn: 1 }, 10));

// ---- B. 新宿主路径：agent/assistant-stream 帧 + 落账事件 ----
// 真实时序：turn/start 先落账，然后 start 帧 → chunk 帧 ×3 → end 帧 → assistant/message
const newSid = 'sess-new';
fire({ id: newSid }, ev('turn/start', { turn: 2 }, 0));
emitFrame(newSid, { type: 'start', attemptId: 1, revision: 1, turn: 2, step: 1 });
emitFrame(newSid, { type: 'chunk', attemptId: 1, revision: 1, index: 0, time: (t += 100), chunk: { type: 'text-delta', text: 'b'.repeat(200) } });
emitFrame(newSid, { type: 'chunk', attemptId: 1, revision: 1, index: 1, time: (t += 100), chunk: { type: 'reasoning-delta', text: '中'.repeat(50) } });
emitFrame(newSid, { type: 'chunk', attemptId: 1, revision: 1, index: 2, time: (t += 100), chunk: { type: 'tool-call-delta', argumentsDelta: 'x'.repeat(80) } });
emitFrame(newSid, { type: 'end', attemptId: 1, revision: 1, index: 3, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 42 } });
fire({ id: newSid }, ev('assistant/message', { turn: 2, step: 1, usage: { outputTokens: 160 }, message: { source: { provider: 'one-api', model: '[free]GLM-5.3' } } }, 100));

// ---- C. 防双计：帧已见过，旧通道 chunk 必须被忽略 ----
fire({ id: newSid }, ev('assistant/chunk', { turn: 2, step: 2, chunk: { type: 'text-delta', text: 'z'.repeat(400) } }, 100));

// ---- 快照断言 ----
const fakeRes = (() => {
	const chunks = [];
	return {
		chunks, headers: null, status: null,
		writeHead(code, headers) { this.status = code; this.headers = headers; },
		end(body) { if (body) chunks.push(body); },
	};
})();
routes[0].handler({ method: 'GET', url: '/token-hud/v1/stats' }, fakeRes);
const snap = JSON.parse(fakeRes.chunks.join(''));

const assert = (cond, msg) => { if (!cond) { console.error('SNAPSHOT:', JSON.stringify(snap, null, 2)); throw new Error('ASSERT FAIL: ' + msg); } };

const oldRow = snap.sessions.find((row) => row.id === 'sess-old');
const newRow = snap.sessions.find((row) => row.id === 'sess-new');
assert(oldRow !== undefined, 'old-channel session tracked');
assert(newRow !== undefined, 'frame-channel session tracked');

// A：400/4=100 估算 → usage 300 校正 +200 → 300
assert(oldRow.sessionOutput === 300, `A sessionOutput 300, got ${oldRow.sessionOutput}`);
// B：帧估算 200/4+50CJK+80/4=120 → usage 160 校正 +40 → 160
assert(newRow.sessionOutput === 160, `B sessionOutput 160 (usage-corrected), got ${newRow.sessionOutput}`);
assert(newRow.turnOutput === 160, `B turnOutput 160, got ${newRow.turnOutput}`);
// C：忽略后的 400/4=100 不得计入
assert(newRow.sessionOutput === 160, `C double-count guard held, got ${newRow.sessionOutput}`);
// B 状态与元数据
assert(newRow.status === 'running' || newRow.status === 'streaming', `B status, got ${newRow.status}`);
assert(newRow.model === '[free]GLM-5.3', 'B model captured from assistant/message');
// B 实时速度：帧样本都落在窗口内
assert(newRow.tps > 0, `B tps positive, got ${newRow.tps}`);
assert(snap.global.tps > 0, 'global tps positive');
assert(snap.global.running === 1, `one running session, got ${snap.global.running}`);

// HEAD / 405 / 404 不炸
routes[0].handler({ method: 'POST', url: '/token-hud/v1/stats' }, { writeHead() {}, end() {} });
routes[0].handler({ method: 'GET', url: '/other' }, { writeHead() {}, end() {} });

if (warnings.length > 0) throw new Error('unexpected warnings: ' + warnings.join('; '));

console.log('ALL HOST TESTS PASSED ✓  (A old-channel=300, B frame-channel=160 tps=' + newRow.tps.toFixed(1) + ', C guard=held)');
