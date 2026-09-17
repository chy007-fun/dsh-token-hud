/**
 * dsh-token-hud host 半边的最小功能测试（无 DSH 宿主直接跑 apply）。
 * 覆盖四条路径：
 *   A. 旧宿主（0.1.2-rc.x）：session/event 的 assistant/chunk 逐 delta 估算
 *   B. 新宿主（0.1.5-rc.2+，format v2）：agent/assistant-stream 帧通道估算
 *   C. 双通道防双计：见到帧后旧通道的 chunk 一律忽略
 *   D. 模型聚合：按 model 归集累计输出 + 峰值 tps；untagged 在模型确定后回填
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

apply(ctx, { apiPath: '/token-hud/v1', windowMs: 1000 });
for (const effect of effects) effect.fn();

const sessionHandler = handlers.get('session/event');
const frameHandler = handlers.get('agent/assistant-stream');
if (typeof sessionHandler !== 'function') throw new Error('session/event handler missing');
if (typeof frameHandler !== 'function') throw new Error('agent/assistant-stream handler missing');

const fire = (session, event) => sessionHandler(session, event);
const emitFrame = (sessionId, frame) => frameHandler({ agent: { session: { id: sessionId } }, frame });
let t = Date.now() - 1000;
const ev = (type, data, dt = 0) => ({ type, data, time: (t += dt) });

// ---- A. 旧宿主路径：assistant/chunk 走 session/event ----
const oldSid = { id: 'sess-old' };
fire(oldSid, ev('turn/start', { turn: 1 }));
fire(oldSid, ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'a'.repeat(400) } }, 100));
fire(oldSid, ev('assistant/message', { turn: 1, step: 1, usage: { outputTokens: 300 }, message: { source: { provider: 'nionio', model: 'glm-5.3' } } }, 100));
fire(oldSid, ev('turn/end', { turn: 1 }, 10));

// ---- B. 新宿主路径：agent/assistant-stream 帧 + request/header 提前锁定模型 ----
const newSid = 'sess-new';
fire({ id: newSid }, ev('turn/start', { turn: 2 }, 0));
fire({ id: newSid }, ev('request/header', { header: { config: { model: 'deepseek-v4-pro', provider: 'one-api' } } }, 0));
emitFrame(newSid, { type: 'start', attemptId: 1, revision: 1, turn: 2, step: 1 });
emitFrame(newSid, { type: 'chunk', attemptId: 1, revision: 1, index: 0, time: (t += 100), chunk: { type: 'text-delta', text: 'b'.repeat(200) } });
emitFrame(newSid, { type: 'chunk', attemptId: 1, revision: 1, index: 1, time: (t += 100), chunk: { type: 'reasoning-delta', text: '中'.repeat(50) } });
emitFrame(newSid, { type: 'chunk', attemptId: 1, revision: 1, index: 2, time: (t += 100), chunk: { type: 'tool-call-delta', argumentsDelta: 'x'.repeat(80) } });
emitFrame(newSid, { type: 'end', attemptId: 1, revision: 1, index: 3, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 42 } });
fire({ id: newSid }, ev('assistant/message', { turn: 2, step: 1, usage: { outputTokens: 160 }, message: { source: { provider: 'one-api', model: 'deepseek-v4-pro' } } }, 100));

// ---- C. 防双计 ----
fire({ id: newSid }, ev('assistant/chunk', { turn: 2, step: 2, chunk: { type: 'text-delta', text: 'z'.repeat(400) } }, 100));

// ---- D. 模型聚合：无 request/header → untagged 回填 ----
const midSid = 'sess-mid';
fire({ id: midSid }, ev('turn/start', { turn: 3 }, 0));
emitFrame(midSid, { type: 'start', attemptId: 1, revision: 1, turn: 3, step: 1 });
emitFrame(midSid, { type: 'chunk', attemptId: 1, revision: 1, index: 0, time: (t += 50), chunk: { type: 'text-delta', text: 'c'.repeat(200) } });
emitFrame(midSid, { type: 'end', attemptId: 1, revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 44 } });
fire({ id: midSid }, ev('assistant/message', { turn: 3, step: 1, usage: { outputTokens: 90 }, message: { source: { provider: 'xiaomi', model: 'mimo-v2.5-pro' } } }, 100));

// ---- 快照断言 ----
const fakeRes = (() => {
	const chunks = [];
	return { chunks, headers: null, status: null, writeHead(code, headers) { this.status = code; this.headers = headers; }, end(body) { if (body) chunks.push(body); } };
})();
routes[0].handler({ method: 'GET', url: '/token-hud/v1/stats' }, fakeRes);
const snap = JSON.parse(fakeRes.chunks.join(''));

const assert = (cond, msg) => { if (!cond) { console.error('SNAPSHOT:', JSON.stringify(snap, null, 2)); throw new Error('ASSERT FAIL: ' + msg); } };

const oldRow = snap.sessions.find((row) => row.id === 'sess-old');
const newRow = snap.sessions.find((row) => row.id === 'sess-new');
const midRow = snap.sessions.find((row) => row.id === 'sess-mid');
assert(oldRow !== undefined, 'A session tracked');
assert(newRow !== undefined, 'B session tracked');
assert(midRow !== undefined, 'D session tracked');

// A：400/4=100 → usage 300 → +200 → 300，模型 glm-5.3
assert(oldRow.sessionOutput === 300, `A sessionOutput 300, got ${oldRow.sessionOutput}`);
assert(oldRow.model === 'glm-5.3', 'A model from assistant/message');

// B：request/header 提前锁定 deepseek-v4-pro；帧 200/4+50CJK+80/4=120 → usage 160 → +40 → 160
assert(newRow.sessionOutput === 160, `B sessionOutput 160, got ${newRow.sessionOutput}`);
assert(newRow.turnOutput === 160, `B turnOutput 160, got ${newRow.turnOutput}`);
assert(newRow.model === 'deepseek-v4-pro', 'B model from request/header');
assert(newRow.tps > 0, `B tps > 0, got ${newRow.tps}`);

// C：ignore guard held
assert(newRow.sessionOutput === 160, `C guard held, got ${newRow.sessionOutput}`);

// D：无 request/header → untagged=50（200/4）→ 模型 mimo-v2.5-pro 到达 → 回填 + usage 90 → diff=+40 → 90
assert(midRow.sessionOutput === 90, `D sessionOutput 90, got ${midRow.sessionOutput}`);
assert(midRow.model === 'mimo-v2.5-pro', 'D model from assistant/message (backfill)');
// untagged 回填通过模型聚合表间接验证（下面检查 mimo-v2.5-pro.outputTokens=90，等于 50回填+40校正）

// 模型聚合表
const modelsMap = new Map(snap.models.map((m) => [m.model, m]));
// glm-5.3: 旧通道 300
assert(modelsMap.get('glm-5.3')?.outputTokens === 300, `M glm-5.3 outputTokens 300, got ${modelsMap.get('glm-5.3')?.outputTokens}`);
// deepseek-v4-pro: 帧 160
assert(modelsMap.get('deepseek-v4-pro')?.outputTokens === 160, `M deepseek-v4-pro outputTokens 160, got ${modelsMap.get('deepseek-v4-pro')?.outputTokens}`);
// mimo-v2.5-pro: untagged 回填 + usage 校正 = 90
assert(modelsMap.get('mimo-v2.5-pro')?.outputTokens === 90, `M mimo-v2.5-pro outputTokens 90, got ${modelsMap.get('mimo-v2.5-pro')?.outputTokens}`);
// 峰值 tps：新通道帧在窗口内 → >0（阈值极低只需 >0 即证明 peak 记录链路通了）
assert(modelsMap.get('deepseek-v4-pro')?.peakTps > 0, `M peakTps > 0, got ${modelsMap.get('deepseek-v4-pro')?.peakTps}`);
// 输出总量不变
assert(snap.global.outputTotal === 550, `global outputTotal 550, got ${snap.global.outputTotal}`);
// 排序：glm-5.3(300) > deepseek-v4-pro(160) > mimo-v2.5-pro(90)
assert(snap.models[0].model === 'glm-5.3' && snap.models[1].model === 'deepseek-v4-pro' && snap.models[2].model === 'mimo-v2.5-pro', 'M sorted desc by output');

// HEAD / 405 / 404
routes[0].handler({ method: 'POST', url: '/token-hud/v1/stats' }, { writeHead() {}, end() {} });
routes[0].handler({ method: 'GET', url: '/other' }, { writeHead() {}, end() {} });

if (warnings.length > 0) throw new Error('unexpected warnings: ' + warnings.join('; '));

console.log(`ALL HOST TESTS PASSED ✓  (A=300 glm·5.3, B=160 tps=${newRow.tps.toFixed(1)}, C guard, D=90 mimo backfill, M sorted+peak ok)`);
