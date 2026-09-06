# dsh-token-hud

[![npm](https://img.shields.io/npm/v/dsh-token-hud?label=npm)](https://www.npmjs.com/package/dsh-token-hud)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)

**DSH Web 全局实时 Token HUD**：一个可拖拽、可折叠的悬浮窗，实时显示整个 DSH（所有会话）的模型输出速度、累计输出 token 与运行状态。

```text
● Token 实时              ← 拖头部移动；– 折叠成小胶囊；□ 展开
  31.4 tok/s              ← 全 DSH 所有活跃会话速度之和
  输出 12.3K tok · 运行中 2
  ● sess-a  deepseek-v4-pro   28.1    ← 每个活跃会话一行
  ● sess-b  (重试等待)
```

状态点：🟢 绿=出字中（脉动）· 🟡 黄=等模型 · 🟠 橙=重试等待（脉动）· 🔵 蓝=工具调用 · ⚪ 灰=空闲/离线。

## 为什么需要它

DSH 内置的统计行只在**提供方上报 usage 且步骤结束后**才显示 tok/s。免费网关模型经常不报 usage，或者中途挂起——这时你无从判断"模型是在慢慢生成，还是已经死了"。本插件从**流式 chunk 直接估算**（中文 ≈1 tok/字，英文 ≈4 字符/tok），不依赖提供方上报，出字即跳动；provider 上报 usage 时自动校正为精确值。配合 `retryPolicy: always`（`@deepseek-ai/dsh-llm-retry`）使用，重试期间橙点闪烁，成功出字转绿，一眼可见。

## 安装

```sh
dsh plugin --profile web add dsh-token-hud
```

重启 `dsh web` 后，页面右下角出现悬浮窗。位置与折叠状态自动记忆（localStorage）。

本地开发安装：

```sh
dsh plugin --profile web add link:<无空格路径>/dsh-token-hud
```

> Windows 下路径含空格会被 dsh 的参数解析拆坏；可用 junction 提供无空格入口：
> `New-Item -ItemType Junction -Path C:\Users\Public\dsh-token-hud -Target <真实目录>`

## 配置（cordis.patch.yml，可选）

```yaml
- insert:
    - id: token-hud
      name: dsh-token-hud
      inject: [webServer]
      config:
        apiPath: /token-hud/v1     # 只读 HTTP 端点前缀
        charsPerToken: 4           # 非 CJK 每 token 字符数
        cjkTokensPerChar: 1        # 每个 CJK 字符的 token 数
        windowMs: 5000             # 速度滚动窗口
        idleTtlMs: 180000          # 空闲会话多久的清理
```

## 工作原理

- **Host 半边**：监听所有会话的 `session/event` 流，`assistant/chunk` 逐字估算、滚动窗口聚合 tok/s；`assistant/message` 携带 usage 时校正估算误差；状态机跟踪 运行/出字/工具/重试/空闲。经 `webServer` 暴露只读端点 `GET /token-hud/v1/stats`。纯内存，零持久化，不写会话日志。
- **Client 半边**：注册进 `shell.overlay`（官方全局悬浮层），每秒轮询渲染；页面隐藏自动暂停；API 失联 5 次显示灰色"离线"胶囊。

## 已知限制

- 速度为**估算值**（~10% 级误差），usage 上报后逐步校正；缓存读写 token 不参与速度。
- Host 重启后累计值清零（无持久化）。
- 悬浮窗显示的是**全 DSH 聚合**，当前打开哪个会话不影响显示内容。

## 测试

```sh
node test.mjs          # host 逻辑（估算/校正/状态机/HTTP）
node test.client.mjs   # 客户端 jsdom 冒烟（渲染/折叠/持久化/离线降级）
```

## License

MIT
