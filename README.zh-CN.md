# opencode-fetch-writer

[![CI](https://github.com/tonydeng/opencode-fetch-writer/actions/workflows/ci.yml/badge.svg)](https://github.com/tonydeng/opencode-fetch-writer/actions/workflows/ci.yml)

OpenCode 插件：改写 provider 出站请求的 **User-Agent** 并增删 **HTTP headers**——适用于任意 provider，完全通过插件 options 配置。

**English: [README.md](./README.md)**

## 为什么需要

把 OpenCode 指向自定义或企业级模型网关时，常见两类故障：

1. **你配置的 `User-Agent` 被静默忽略。** 部分 SDK 在合并 `provider.options.headers` *之后*再叠加自己的默认 UA，网关根本看不到你配置的 UA。
2. **网关直接拒绝请求**，因为默认客户端指纹不合规（UA 或中间层附加的 headers）。

本插件通过官方 `config` hook 包装 provider 的 `options.fetch` 解决以上两个问题。`options.fetch` 是请求的最终出口——在这里设置的 headers 不会被 SDK 默认值覆盖。

## 安装

### OpenCode v1（1.x，元组语法）

```jsonc
// opencode.jsonc
{
  "plugin": [
    ["opencode-fetch-writer@0.1.0", {
      "providerId": "my-provider",
      "uaTarget": "my-app/1.0.0",
      "headersToStrip": ["x-unwanted-header"],
      "headersToInject": {
        "X-Client-Name": "my-app"
      }
    }]
  ]
}
```

### OpenCode v2（对象语法）

```jsonc
{
  "plugins": [
    {
      "package": "opencode-fetch-writer@0.1.0",
      "options": {
        "providerId": "my-provider",
        "uaTarget": "my-app/1.0.0",
        "headersToStrip": ["x-unwanted-header"],
        "headersToInject": {
          "X-Client-Name": "my-app"
        }
      }
    }
  ]
}
```

### 本地开发

```jsonc
{
  "plugin": ["file://./src/index.ts"]
}
```

## Options

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `providerId` | `string` | — | Provider ID（`provider` 映射中的键）。**必填**——缺省时插件不激活。 |
| `uaTarget` | `string` | — | 目标 User-Agent。缺省则不改写 UA。 |
| `headersToStrip` | `string[]` | `[]` | 需要从出站请求中删除的 header 名。 |
| `headersToInject` | `Record<string, string>` | `{}` | 缺失时注入的 headers。**从不覆盖**已有值。 |
| `debug` | `boolean` | `false` | 向 stderr 输出调试日志。 |

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `FETCH_WRITER_UA` | 覆盖 `uaTarget` 选项 | — |
| `FETCH_WRITER_DEBUG` | 设为 `1` 启用调试日志 | `0` |

## 行为说明

- **MARKER 守卫**：插件在包装后的 fetch 上打标记，拒绝二次包装。即使同时被 plugins/ 目录自动加载和配置文件显式引用，请求也只会被包装一次。
- **激活日志**：启动时插件总会向 stderr 输出一行 `[fetch-writer] patched options.fetch for provider "…"`，便于确认生效。
- **兼容两种 fetch 调用形态**：`fetch(url, init)` 与 `fetch(new Request(...))`。

## 问题排查

- **插件不生效**——检查 `providerId` 是否与 `provider` 映射中的键完全一致（区分大小写）。
- **UA 仍被覆盖**——确认没有其他插件或 provider option 在本插件之后再次设置自定义 `fetch`。
- **双重注入**——MARKER 守卫已处理；若激活日志出现两次，说明有两个*不同*的 fetch 包装器在生效，而非本插件重复加载。

## 开发

```bash
bun install
bun run typecheck
bun run build
bun test
```

## 许可证

[MIT](./LICENSE)
