（除了这段文字以外，其他均由copilot生成，项目名也是，而且copilot没列全，请去查看[worker.js](https://github.com/fgfobdpqjs/edge-mirror-proxy/blob/main/worker.js)的注释）

# Cloudflare Worker: 路径镜像与域名/Cookie 重写

简短概括（Summary）
-------------------
这是一个可配置的 Cloudflare Worker 脚本（worker.js），用于将你域名下的某个路径（例如 `/a*`）代理并镜像上游站点，同时支持：
- 在响应与 HTML 中替换指定主机名（HOST_MAP）；
- 重写或移除来自特定上游的 `Set-Cookie` 的 `domain=` 字段（COOKIE_DOMAIN_MAP）；
- 重写 `Location` 头并使用 `HTMLRewriter` 替换 HTML 中的常见资源 URL；
- 对非 HTML 头部字段做保守的字符串替换以修正指向外部域的预加载或资源引用。

重要免责声明
------------
本项目仅供学习使用。请勿在未获授权的情况下镜像或修改第三方站点内容；对用户数据与隐私的任何处理请自行负责并遵守相关法律法规。

标签（Tags）
------------
- cloudflare
- workers
- proxy
- reverse-proxy
- cookie-rewrite
- host-mapping
- html-rewriter
- edge
- security
- config

文件列表
--------
- worker.js — 主 Worker 脚本（包含 HOST_MAP 与 COOKIE_DOMAIN_MAP 配置）
- README.md — 本说明文档（包括配置说明、快速开始、测试与注意事项）
- LICENSE — 项目许可文件（MIT License）

配置片段示例（你常用的展示方式）
--------------------------------
在 worker.js 顶部你会看到类似下面的配置片段。下面先展示原样代码，然后解释如何配置与它们的作用。

示例代码（放在 worker.js 的配置区）：
```javascript
const HOST_MAP = {
  "github.com": "facebook.com",
  "google.com": "microsoft.com",
  // 你可以继续添加映射
};

const COOKIE_DOMAIN_MAP = {
  "x.com": "youtube.com",
  "discord.com": "tiktok.com",
  // Add others as needed
};
```

如何配置与它们能干什么（逐项说明）
-----------------------------------
1) HOST_MAP
- 作用：
  - 将响应头（如 Location）和 HTML 静态属性（a[href], img[src], script[src], link[href] 等）中出现的 host 替换为映射表中的目标 host。
  - 常见用途：隐藏真实上游、把第三方域名替换为你希望展示的域名、或将站点中指向某些服务的链接指向其他域名（比如灰度替换、CDN 切换、品牌替换等）。
- 配置方式：
  - key：原始 host（如 "github.com"）
  - value：替换后的 host（如 "facebook.com"）
  - 可包含端口，例如 "api.example.com:8443"
- 注意：
  - 只替换 host，不自动修改 path 或协议。
  - 仅影响静态 HTML 与头部。JS 运行时动态构造的 URL（fetch/XHR）不会被自动替换，除非你对 JS 文本做额外替换（有风险）。
  - 替换目标必须能提供相同资源，否则资源会 404 或因证书/跨域问题加载失败。

2) COOKIE_DOMAIN_MAP
- 作用：
  - 将上游返回的 `Set-Cookie` 头中的 `domain=` 字段替换为你指定的域名，或移除该字段（设为空字符串），以便 cookie 在你自己的域名下生效。
  - 常用于镜像场景，使登录/会话 cookie 在镜像站点有效。
- 配置方式：
  - key：上游 cookie 的原始域（如 "zrf.me"）
  - value：替换目标域（如 "expmale.com"），或空字符串 `""` 表示移除 `domain=` 子串
- 注意：
  - Cookie 属性（Secure、SameSite、Path 等）会影响浏览器是否接受或发送 cookie。Secure 需要 HTTPS；SameSite 可能阻止跨站发送。
  - 变更 cookie domain 有安全与法律影响：请确保你有权这么做并妥善保护用户数据。

部署与快速开始
----------------
1. 在 Cloudflare 仪表盘接入你的域名（将注册商的 Nameserver 指向 Cloudflare）。
2. 在 Workers 中创建或编辑 Worker，把 `worker.js` 粘贴进编辑器并保存。
3. 在 Worker 的 Triggers/Routes 中添加路由，例如：
   - yourdomain.com/a*
4. 部署并访问：
   - https://yourdomain.com/a

测试命令（建议）
----------------
- 检查响应头与重定向：
  - curl -i -L 'https://yourdomain.com/a'
- 检查 Set-Cookie：
  - curl -i 'https://yourdomain.com/a' | grep -i Set-Cookie
- 在浏览器中打开页面并用 DevTools 的 Network / Application 面板检查资源与 Cookie 是否按预期。

常见问题与排查要点
-------------------
- 页面仍有原始域：可能为 JS 动态生成的 URL 或 CSS/url(...) 未被替换。扩展替换逻辑或对 JS/CSS 做文本替换（需谨慎）。
- Cookie 未生效：检查 Secure/Path/SameSite 以及浏览器控制台的 cookie 错误。
- 资源 404 或证书错误：host 替换后目标域可能没有相应资源或 TLS 不匹配，需确保目标 host 可访问相同资源。

安全与合规提醒（显著）
----------------------
本项目仅供学习使用。请勿在未获授权的情况下镜像或修改第三方站点内容；对用户数据与隐私的任何处理请自行负责并遵守相关法律法规。

进阶建议（可选）
----------------
- 将 HOST_MAP / COOKIE_DOMAIN_MAP 提取为环境绑定（Worker 环境变量 / KV / Secret），避免在源码中硬编码。
- 为 application/javascript 或 text/* 类型添加可选的文本替换，但须带回退与白名单以减少破坏风险。
- 实现更细粒度的 CSP 改写（而不是删除），解析 CSP 并替换来源列表。
- 使用 Cache API 减少上游请求与成本。

用到的项目 / 平台 / API（在此列出，方便依赖说明）
------------------------------------------------------------
本项目主要基于 Cloudflare Workers 平台与原生 Web API 开发；没有引入第三方 npm 包。你可以在 README 的依赖部分直接说明如下项：

- Cloudflare Workers（运行时平台）
  - HTMLRewriter（Cloudflare Workers 内置 API，用于流式改写 HTML）
  - Fetch API（全局 fetch，用于向上游发起请求）
  - Headers / Request / Response（标准 Web Fetch API 类型）
- JavaScript（ES2020+，无外部库）
- 测试/调试工具（非代码依赖，仅建议）
  - curl（用于命令行测试）
  - 浏览器 DevTools（用于网络与 Cookie 调试）

LICENSE
-------
本项目使用 MIT 许可证（LICENSE 文件位于仓库根目录）。
