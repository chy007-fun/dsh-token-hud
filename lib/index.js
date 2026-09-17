/**
 * dsh-token-hud — 全局实时 Token HUD（host 半边）。
 *
 * 监听所有会话的 `session/event` 流，按滚动窗口估算每个会话的实时输出速度
 * （tok/s，字符启发式，提供方上报 usage 时校正为精确值），维护运行/重试/工具
 * 状态，并通过 webServer 暴露只读 HTTP 端点供客户端悬浮窗轮询。
 *
 * 纯内存、零持久化、零提示词注入：不写任何文件，不进会话日志。
 */
import z from '@deepseek-ai/schemastery';

export const name = 'token-hud';
export const inject = ['webServer'];

export const Config = z.object({
	apiPath: z.string().default('/token-hud/v1').description('Same-origin read-only API prefix.'),
	charsPerToken: z.number().min(1).max(20).default(4).description('Approximate non-CJK characters per token.'),
	cjkTokensPerChar: z.number().min(0.25).max(3).default(1).description('Approximate tokens per CJK character.'),
	windowMs: z.natural().min(1000).max(60000).default(5000).description('Rolling TPS measurement window.'),
	idleTtlMs: z.natural().min(15000).max(3600000).default(180000).description('Evict idle sessions after this long.'),
});

/** CJK（含假名/谚文）码点判定：这些字符按 ~1 token/字 估算，其余按 charsPerToken。 */
const CJK_RANGES = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function makeSession(id) {
	return {
		id,
		status: 'idle', // idle | running | streaming | tool | retrying
		samples: [], // { t, tokens } 滚动窗口样本
		turnOutput: 0,
		sessionOutput: 0,
		stepEstimate: 0,
		turnStartedAt: null,
		lastChunkAt: null,
		lastEventAt: 0,
		model: null,
		provider: null,
	};
}

function finiteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

class Hud {
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		this.sessions = new Map();
		this.evictedOutput = 0; // 被清理会话的累计输出，并入全局总量
		this.liveFramesSeen = false; // 见到 agent/assistant-stream 帧后，停用旧版 chunk 通道防双计
		this.apiPath = config.apiPath.replace(/\/$/, '');
	}

	estimate(text) {
		if (typeof text !== 'string' || text === '') return 0;
		let cjk = 0;
		for (const ch of text) if (CJK_RANGES.test(ch)) cjk += 1;
		const other = text.length - cjk;
		return cjk * this.config.cjkTokensPerChar + other / this.config.charsPerToken;
	}

	addTokens(session, tokens, at) {
		if (!(tokens > 0)) return;
		session.turnOutput += tokens;
		session.sessionOutput += tokens;
		session.samples.push({ t: at, tokens });
		session.lastChunkAt = at;
	}

	onEvent(session, event) {
		session.lastEventAt = event.time;
		switch (event.type) {
			case 'turn/start':
				session.status = 'running';
				session.turnOutput = 0;
				session.turnStartedAt = event.time;
				break;
			case 'step/start':
				session.status = 'running';
				session.stepEstimate = 0;
				break;
			case 'assistant/chunk': {
				// 0.1.2-rc.x 通道：新版（0.1.5-rc.2+，format v2）把逐 delta 流挪进了
				// `agent/assistant-stream` 帧通道，session log 只在尝试结束落一个完整
				// `assistant/attempt`。两通道互斥；一旦见到帧，本通道一律忽略防双计。
				if (this.liveFramesSeen) break;
				const chunk = event.data?.chunk;
				if (!chunk) break;
				let text = '';
				if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') text = chunk.text ?? '';
				else if (chunk.type === 'tool-call-delta') text = chunk.argumentsDelta ?? '';
				const tokens = this.estimate(text);
				if (tokens > 0) {
					session.stepEstimate += tokens;
					this.addTokens(session, tokens, event.time);
					session.status = 'streaming';
				}
				break;
			}
			case 'assistant/message': {
				// 提供方 usage 到达：把本步估算校正为精确输出 token 数。
				const actual = finiteNumber(event.data?.usage?.outputTokens);
				if (actual !== null) {
					const diff = actual - session.stepEstimate;
					if (diff > 0) {
						session.turnOutput += diff;
						session.sessionOutput += diff;
						const last = session.samples.at(-1);
						if (last) last.tokens += diff;
					} else if (diff < 0) {
						session.turnOutput = Math.max(0, session.turnOutput + diff);
						session.sessionOutput = Math.max(0, session.sessionOutput + diff);
						const last = session.samples.at(-1);
						if (last) last.tokens = Math.max(0, last.tokens + diff);
					}
				}
				const source = event.data?.message?.source;
				if (source?.model) session.model = source.model;
				if (source?.provider) session.provider = source.provider;
				session.stepEstimate = 0;
				if (session.status === 'streaming') session.status = 'running';
				break;
			}
			case 'tool/call':
				session.status = 'tool';
				break;
			case 'tool/result':
				if (session.status === 'tool') session.status = 'running';
				break;
			case 'llm/retry':
				session.status = 'retrying';
				break;
			case 'llm/retry-started':
				if (session.status === 'retrying') session.status = 'running';
				break;
			case 'step/end':
				session.stepEstimate = 0;
				break;
			case 'turn/end':
				session.status = 'idle';
				session.turnStartedAt = null;
				break;
		}
	}

	accept(sessionRecord, event) {
		const id = String(sessionRecord.id);
		let session = this.sessions.get(id);
		if (session === undefined) {
			session = makeSession(id);
			this.sessions.set(id, session);
		}
		try {
			this.onEvent(session, event);
		} catch (error) {
			this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/**
	 * 新版（0.1.5-rc.2+，format v2）实时流通道：loop 每收到一个 model chunk 就广播
	 * `agent/assistant-stream` 帧（start/chunk/end），与 session log 的落账事件互补。
	 * 逐 chunk 估算在这里做；`start` 重置本尝试的估算基线（重试是同 turn/step 的新尝试）。
	 */
	acceptFrame(agent, frame) {
		this.liveFramesSeen = true;
		const id = String(agent.session.id);
		let session = this.sessions.get(id);
		if (session === undefined) {
			session = makeSession(id);
			this.sessions.set(id, session);
		}
		try {
			if (frame.type === 'start') {
				session.lastEventAt = Date.now();
				session.stepEstimate = 0;
				if (session.status === 'idle') session.status = 'running';
			} else if (frame.type === 'chunk') {
				session.lastEventAt = Date.now();
				const chunk = frame.chunk;
				if (chunk !== null && typeof chunk === 'object') {
					let text = '';
					if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') text = chunk.text ?? '';
					else if (chunk.type === 'tool-call-delta') text = chunk.argumentsDelta ?? '';
					const tokens = this.estimate(text);
					if (tokens > 0) {
						session.stepEstimate += tokens;
						this.addTokens(session, tokens, frame.time);
						session.status = 'streaming';
					}
				}
			}
			// 'end' 帧：committed/abandoned，状态交由 turn/step/session 落账事件驱动。
		} catch (error) {
			this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
		}
	}

	tps(session, now) {
		const { windowMs } = this.config;
		const cutoff = now - windowMs;
		while (session.samples.length > 0 && session.samples[0].t < cutoff) session.samples.shift();
		if (session.samples.length === 0) return 0;
		let sum = 0;
		for (const sample of session.samples) sum += sample.tokens;
		return (sum / windowMs) * 1000;
	}

	prune(now) {
		for (const [id, session] of this.sessions) {
			if (session.status === 'idle' && now - session.lastEventAt > this.config.idleTtlMs) {
				this.evictedOutput += session.sessionOutput;
				this.sessions.delete(id);
			}
		}
	}

	snapshot() {
		const now = Date.now();
		this.prune(now);
		const rows = [];
		let globalTps = 0;
		let running = 0;
		let liveOutput = 0;
		for (const session of this.sessions.values()) {
			const tps = this.tps(session, now);
			globalTps += tps;
			if (session.status !== 'idle') running += 1;
			liveOutput += session.sessionOutput;
			rows.push({
				id: session.id,
				status: session.status,
				tps: Math.round(tps * 10) / 10,
				turnOutput: Math.round(session.turnOutput),
				sessionOutput: Math.round(session.sessionOutput),
				turnMs: session.turnStartedAt === null ? null : Math.max(0, now - session.turnStartedAt),
				lastChunkAgeMs: session.lastChunkAt === null ? null : Math.max(0, now - session.lastChunkAt),
				lastEventAgeMs: Math.max(0, now - session.lastEventAt),
				model: session.model,
				provider: session.provider,
			});
		}
		rows.sort((a, b) => b.tps - a.tps || b.lastEventAgeMs - a.lastEventAgeMs);
		return {
			serverTime: now,
			windowMs: this.config.windowMs,
			global: {
				tps: Math.round(globalTps * 10) / 10,
				running,
				tracked: rows.length,
				outputTotal: Math.round(liveOutput + this.evictedOutput),
			},
			sessions: rows.slice(0, 20),
		};
	}

	handle(req, res) {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405, { allow: 'GET, HEAD' });
			res.end();
			return;
		}
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		if (path !== this.apiPath && path !== `${this.apiPath}/stats`) {
			sendJson(res, 404, { error: 'Not found' });
			return;
		}
		sendJson(res, 200, req.method === 'HEAD' ? null : this.snapshot());
	}

	start() {
		this.ctx.on('session/event', (session, event) => this.accept(session, event));
		// 0.1.5-rc.2+（format v2）的实时流通道；老宿主上此事件不存在，注册本身无害。
		// { global: true } 与 dsh-api-session-controller 的用法一致，接收全部 agent（含子代理）。
		this.ctx.on('agent/assistant-stream', ({ agent, frame }) => this.acceptFrame(agent, frame), { global: true });
		this.ctx.effect(() => this.ctx.webServer.register({
			kind: 'prefix',
			path: this.apiPath,
			handler: (req, res) => this.handle(req, res),
		}), 'token-hud: read-only stats API');
	}
}

function sendJson(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(json),
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	res.end(json);
}

export function apply(ctx, config = {}) {
	new Hud(ctx, {
		apiPath: config.apiPath ?? '/token-hud/v1',
		charsPerToken: config.charsPerToken ?? 4,
		cjkTokensPerChar: config.cjkTokensPerChar ?? 1,
		windowMs: config.windowMs ?? 5000,
		idleTtlMs: config.idleTtlMs ?? 180000,
	}).start();
}
