/**
 * dsh-token-hud — 客户端悬浮窗（client 半边）。
 *
 * 每秒轮询 host 侧 /token-hud/v1/stats，把整个 DSH 的实时输出速度
 * （tok/s）、累计输出与各会话运行状态渲染成一个可拖拽、可折叠的悬浮卡片。
 * 页面隐藏时自动暂停轮询；API 不可达时静默隐藏。
 */
window.__ModuleLoader__.load({
	id: 'dsh-token-hud',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		let react = require('react');
		let react_jsx_runtime = require('react/jsx-runtime');

		const inject = ['slots'];
		const API_PATH = '/token-hud/v1';
		const POS_KEY = 'dsh-token-hud:pos';
		const COLLAPSED_KEY = 'dsh-token-hud:collapsed';

		const zh = navigator.language && navigator.language.toLowerCase().startsWith('zh');
		const L = zh
			? { title: 'Token 实时', output: '输出', running: '运行中', offline: '离线', tok: 'tok', models: '模型用量（重启清零）', peak: '峰值' }
			: { title: 'Token HUD', output: 'output', running: 'running', offline: 'offline', tok: 'tok', models: 'Model usage (resets on restart)', peak: 'peak' };

		const CSS = [
			'.th-hud{position:fixed;z-index:900;min-width:190px;max-width:280px;border-radius:12px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#1e1e1e) 88%, transparent);color:var(--dsw-alias-label-primary,#e5e5e5);box-shadow:0 12px 38px rgba(0,0,0,.28);backdrop-filter:blur(12px);font-size:12px;line-height:1.5;user-select:none}',
			'.th-hud *{font-variant-numeric:tabular-nums}',
			'.th-head{display:flex;align-items:center;gap:6px;padding:6px 8px 2px 10px;cursor:grab;touch-action:none}',
			'.th-head:active{cursor:grabbing}',
			'.th-title{flex:1;font-weight:600;opacity:.85;white-space:nowrap}',
			'.th-btn{border:none;background:transparent;color:inherit;cursor:pointer;padding:2px 6px;border-radius:6px;font-size:12px;line-height:1}',
			'.th-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}',
			'.th-body{padding:0 10px 8px}',
			'.th-tps{font-size:22px;font-weight:700;letter-spacing:.2px}',
			'.th-tps small{font-size:11px;font-weight:500;opacity:.65;margin-left:4px}',
			'.th-line{opacity:.78;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.th-rows{margin-top:4px;display:flex;flex-direction:column;gap:2px;max-height:120px;overflow:hidden}',
			'.th-row{display:flex;align-items:center;gap:6px;opacity:.85;white-space:nowrap;overflow:hidden}',
			'.th-sid{font-family:var(--dsh-font-mono,monospace);opacity:.7}',
			'.th-stps{margin-left:auto;font-weight:600}',
			'.th-model{max-width:88px;overflow:hidden;text-overflow:ellipsis;opacity:.6}',
			'.th-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#8b8b8b}',
			'.th-dot.th-streaming{background:#34d399;box-shadow:0 0 6px #34d39980;animation:th-pulse 1s ease-in-out infinite}',
			'.th-dot.th-running{background:#facc15}',
			'.th-dot.th-tool{background:#60a5fa}',
			'.th-dot.th-retrying{background:#fb923c;animation:th-pulse .7s ease-in-out infinite}',
			'.th-dot.th-idle{background:#8b8b8b}',
			'@keyframes th-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
			'.th-pill{position:fixed;z-index:900;display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));background:color-mix(in srgb, var(--dsw-alias-bg-layer-2,#1e1e1e) 88%, transparent);color:var(--dsw-alias-label-primary,#e5e5e5);font-size:12px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.25);backdrop-filter:blur(10px);cursor:grab;touch-action:none;user-select:none}',
			'.th-pill *{font-variant-numeric:tabular-nums}',
			'.th-models{margin-top:5px;padding-top:4px;border-top:1px solid var(--dsw-alias-separator-primary,rgba(128,128,128,.25))}',
			'.th-models-head{font-size:11px;font-weight:600;opacity:.6;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.th-mrow{display:flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;opacity:.85}',
			'.th-mname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
			'.th-mtok{font-weight:600;flex-shrink:0}',
			'.th-mtps{flex-shrink:0;opacity:.75}',
		].join('\n');

		function fmtTps(value) {
			if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0';
			return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
		}

		function fmtTokens(value) {
			if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0';
			if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
			if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';
			return String(Math.round(value));
		}

		function fmtAge(ms) {
			if (typeof ms !== 'number') return '';
			if (ms < 2000) return '';
			if (ms < 60000) return Math.round(ms / 1000) + 's';
			return Math.floor(ms / 60000) + 'm';
		}

		function readPos() {
			try {
				const raw = localStorage.getItem(POS_KEY);
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				if (typeof parsed.left === 'number' && typeof parsed.top === 'number') return parsed;
			} catch { /* 忽略损坏的存储 */ }
			return null;
		}

		/** 头部拖拽：pointermove 更新 state，pointerup 落盘 localStorage。 */
		function useDraggable(rootRef, setPos) {
			return (event) => {
				const el = rootRef.current;
				if (!el || event.button !== 0) return;
				const rect = el.getBoundingClientRect();
				const offX = event.clientX - rect.left;
				const offY = event.clientY - rect.top;
				event.preventDefault();
				let latest = null;
				const move = (ev) => {
					const left = Math.min(Math.max(4, ev.clientX - offX), window.innerWidth - 60);
					const top = Math.min(Math.max(4, ev.clientY - offY), window.innerHeight - 32);
					latest = { left, top };
					setPos(latest);
				};
				const up = () => {
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', up);
					try {
						if (latest) localStorage.setItem(POS_KEY, JSON.stringify(latest));
					} catch { /* 存储不可用则只保持本次会话位置 */ }
				};
				window.addEventListener('pointermove', move);
				window.addEventListener('pointerup', up);
			};
		}

		function Hud() {
			const rootRef = react.useRef(null);
			const [stats, setStats] = react.useState(null);
			const [failures, setFailures] = react.useState(0);
			const [pos, setPos] = react.useState(readPos);
			const [collapsed, setCollapsed] = react.useState(() => {
				try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
			});

			react.useEffect(() => {
				let stop = false;
				const tick = async () => {
					if (document.hidden) return;
					try {
						const response = await fetch(`${API_PATH}/stats`, { cache: 'no-store' });
						if (!response.ok) throw new Error(String(response.status));
						const body = await response.json();
						if (!stop) { setStats(body); setFailures(0); }
					} catch {
						if (!stop) setFailures((value) => value + 1);
					}
				};
				tick();
				const timer = setInterval(tick, 1000);
				return () => { stop = true; clearInterval(timer); };
			}, []);

			const toggleCollapsed = () => setCollapsed((value) => {
				const next = !value;
				try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* 忽略 */ }
				return next;
			});

			const dragHandler = useDraggable(rootRef, setPos);
			const style = pos ? { left: pos.left, top: pos.top } : { right: 16, bottom: 96 };

			// API 从未成功且连续失败多次：显示灰色“离线”小胶囊而不是整个消失。
			if (stats === null && failures >= 5) {
				return react_jsx_runtime.jsxs('div', {
					ref: rootRef,
					className: 'th-pill',
					style,
					onPointerDown: dragHandler,
					title: `${L.offline} (${failures})`,
					children: [
						react_jsx_runtime.jsx('span', { className: 'th-dot th-idle' }),
						react_jsx_runtime.jsx('span', { children: L.offline }),
						react_jsx_runtime.jsx('button', {
							type: 'button',
							className: 'th-btn',
							onPointerDown: (event) => event.stopPropagation(),
							onClick: toggleCollapsed,
							children: '□',
						}),
					],
				});
			}

			const sessions = stats?.sessions ?? [];
			const globalStatus = sessions.some((row) => row.status === 'streaming') ? 'streaming'
				: sessions.some((row) => row.status === 'retrying') ? 'retrying'
				: sessions.some((row) => row.status === 'tool') ? 'tool'
				: sessions.some((row) => row.status === 'running') ? 'running'
				: 'idle';
			const tpsText = fmtTps(stats?.global?.tps);

			if (collapsed) {
				return react_jsx_runtime.jsxs('div', {
					ref: rootRef,
					className: 'th-pill',
					style,
					onPointerDown: dragHandler,
					title: `${L.running} ${stats?.global?.running ?? 0}`,
					children: [
						react_jsx_runtime.jsx('span', { className: `th-dot th-${globalStatus}` }),
						react_jsx_runtime.jsxs('span', { children: [tpsText, ' tok/s'] }),
						react_jsx_runtime.jsx('button', {
							type: 'button',
							className: 'th-btn',
							onPointerDown: (event) => event.stopPropagation(),
							onClick: toggleCollapsed,
							children: '□',
						}),
					],
				});
			}

			const visible = sessions.filter((row) => row.status !== 'idle' || (row.lastChunkAgeMs ?? 1e9) < 15000).slice(0, 5);
			return react_jsx_runtime.jsxs('div', {
				ref: rootRef,
				className: 'th-hud',
				style,
				children: [
					react_jsx_runtime.jsxs('div', {
						className: 'th-head',
						onPointerDown: dragHandler,
						children: [
							react_jsx_runtime.jsx('span', { className: `th-dot th-${globalStatus}` }),
							react_jsx_runtime.jsx('span', { className: 'th-title', children: L.title }),
							react_jsx_runtime.jsx('button', {
								type: 'button',
								className: 'th-btn',
								onPointerDown: (event) => event.stopPropagation(),
								onClick: toggleCollapsed,
								title: L.offline,
								children: '–',
							}),
						],
					}),
					react_jsx_runtime.jsxs('div', {
						className: 'th-body',
						children: [
							react_jsx_runtime.jsxs('div', {
								className: 'th-tps',
								children: [tpsText, react_jsx_runtime.jsx('small', { children: 'tok/s' })],
							}),
							react_jsx_runtime.jsxs('div', {
								className: 'th-line',
								children: [
									`${L.output} ${fmtTokens(stats?.global?.outputTotal)} ${L.tok}`,
									' · ',
									`${L.running} ${stats?.global?.running ?? 0}`,
								],
							}),
							visible.length > 0 ? react_jsx_runtime.jsx('div', {
								className: 'th-rows',
								children: visible.map((row) => react_jsx_runtime.jsxs('div', {
									className: 'th-row',
									key: row.id,
									children: [
										react_jsx_runtime.jsx('span', { className: `th-dot th-${row.status}` }),
										react_jsx_runtime.jsx('span', { className: 'th-sid', children: String(row.id).slice(0, 6) }),
										row.model ? react_jsx_runtime.jsx('span', { className: 'th-model', children: row.model }) : null,
										react_jsx_runtime.jsxs('span', {
											className: 'th-stps',
											children: [fmtTps(row.tps), row.status === 'idle' && row.lastChunkAgeMs !== null ? ` (${fmtAge(row.lastChunkAgeMs)})` : ''],
										}),
									],
								})),
							}) : null,
							(stats?.models?.length ?? 0) > 0 ? react_jsx_runtime.jsxs('div', {
								className: 'th-models',
								children: [
									react_jsx_runtime.jsx('div', { className: 'th-models-head', children: L.models }),
									...stats.models.slice(0, 3).map((entry) => react_jsx_runtime.jsxs('div', {
										className: 'th-mrow',
										key: entry.model,
										title: `${entry.provider ? entry.provider + '::' : ''}${entry.model} · ${L.output} ${fmtTokens(entry.outputTokens)} tok · ${L.peak} ${fmtTps(entry.peakTps)} tok/s`,
										children: [
											react_jsx_runtime.jsx('span', { className: 'th-mname', children: entry.model }),
											react_jsx_runtime.jsxs('span', { className: 'th-mtok', children: ['↑', fmtTokens(entry.outputTokens)] }),
											react_jsx_runtime.jsxs('span', { className: 'th-mtps', children: ['⚡', fmtTps(entry.peakTps)] }),
										],
									})),
								],
							}) : null,
						],
					}),
				],
			});
		}

		function apply(ctx) {
			const style = document.createElement('style');
			style.dataset.plugin = 'dsh-token-hud';
			style.textContent = CSS;
			document.head.appendChild(style);
			ctx.effect(() => () => { style.remove(); }, 'token-hud: styles');
			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'token-hud',
				order: 30,
				inject: () => ({}),
			}, Hud));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
