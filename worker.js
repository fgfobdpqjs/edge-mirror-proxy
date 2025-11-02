
addEventListener("fetch", event => {
  event.respondWith(handle(event.request));
});

/**
 * 配置区（按需修改）
 */
const ORIGIN = "https://expmale.com";        // 主要被代理的上游 origin（示例）
const ORIGIN_PATH = "/";                // 上游资源的路径（示例），用于构造目标 URL
const LOCAL_PREFIX = "/a";               // 本域下的映射前缀（Worker 路由通常为 你的域名/a*）

// 域名映射表：把上游域名（或任意请求/响应中出现的域）替换为目标域。
// key: 要被替换的上游主机名（可以包含端口），value: 替换为的主机名（可包含端口或整个 scheme+host）
const HOST_MAP = {
  "github.com": "facebook.com",
  "google.com": "microsoft.com",
  // 你可以继续添加映射
};

// 针对 Set-Cookie 的 domain 重写表：当 Set-Cookie 来源于上游域（匹配键），将 cookie 中的 domain= 替换成对应的值。
// 若值为 ""（空字符串），则会移除 domain=... 子串（让 cookie 归属当前域）。
const COOKIE_DOMAIN_MAP = {
  "x.com": "youtube.com",   // 把来自 x.com 的 cookie 改成 youtube.com
  "discord.com": "tiktok.com",    // 把来自 discord.com 的 cookie 改成 tiktok.com
  // Add others as needed
};

// 用来判断是否需要对某个 URL 做本域前缀替换（若上游 URL 属于 ORIGIN 或 ORIGIN host）
function shouldMapToLocal(url) {
  try {
    const u = new URL(url, ORIGIN);
    return u.host === (new URL(ORIGIN)).host;
  } catch (e) {
    return false;
  }
}

/**
 * 主处理函数
 */
async function handle(request) {
  const reqUrl = new URL(request.url);
  // 构造上游 URL：把本地 /abc/* 映射到 ORIGIN+ORIGIN_PATH/*
  const prefix = LOCAL_PREFIX;
  let suffix = reqUrl.pathname.startsWith(prefix) ? reqUrl.pathname.slice(prefix.length) : "";
  const targetUrl = new URL(ORIGIN + ORIGIN_PATH + suffix + reqUrl.search);

  // 构造发往上游的请求头（拷贝并可按需修改）
  const newHeaders = new Headers(request.headers);
  // 设置 Host 为上游 host（某些上游需要）
  newHeaders.set("Host", new URL(ORIGIN).host);
  // 可选：删除或改写某些头
  newHeaders.delete("cf-connecting-ip");

  const fetchInit = {
    method: request.method,
    headers: newHeaders,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual"
  };

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl.toString(), fetchInit);
  } catch (err) {
    return new Response("Upstream fetch failed: " + err.message, { status: 502 });
  }

  // 复制并准备处理响应头
  const respHeaders = new Headers(upstreamResponse.headers);

  // 1) 处理 Location 头（重写到本域或做 host 映射）
  if (respHeaders.has("Location")) {
    const loc = respHeaders.get("Location");
    try {
      // 如果 Location 指向上游 origin（或以 / 开头），重写到本域的 /abc 前缀
      if (shouldMapToLocal(loc)) {
        const locUrl = new URL(loc, ORIGIN);
        const newLoc = `${new URL(request.url).origin}${prefix}${locUrl.pathname.replace(ORIGIN_PATH, "")}${locUrl.search}${locUrl.hash || ""}`;
        respHeaders.set("Location", newLoc);
      } else {
        // 普通 host 映射: 如果 Location 中包含 HOST_MAP 的某个 key，则替换
        let newLoc = loc;
        for (const [k, v] of Object.entries(HOST_MAP)) {
          // 替换完整主机名（支持包含端口）
          const re = new RegExp(`(^https?:\/\/)(${escapeRegExp(k)})`, "i");
          newLoc = newLoc.replace(re, `$1${v}`);
        }
        respHeaders.set("Location", newLoc);
      }
    } catch (e) {
      // 若解析异常，保留原 Location
    }
  }

  // 2) 处理 Set-Cookie：将属于上游域的 Set-Cookie domain 替换为本域（或移除）
  // 多个 Set-Cookie 需要单独处理并通过 Headers.append 添加
  const cookies = [];
  try {
    // 多值读取：部分 runtime 支持 headers.getAll；否则读取单个并拆分
    if (typeof upstreamResponse.headers.getAll === "function") {
      const sc = upstreamResponse.headers.getAll("Set-Cookie");
      if (sc && sc.length) {
        sc.forEach(c => cookies.push(c));
      }
    } else {
      const scRaw = upstreamResponse.headers.get("Set-Cookie");
      if (scRaw) {
        // 有些上游会把多个 Set-Cookie 合并为多行或以 \n 分隔
        scRaw.split(/\r?\n/).forEach(c => { if (c.trim()) cookies.push(c.trim()); });
      }
    }
  } catch (e) {
    // ignore
  }

  // 将原 Set-Cookie 从 respHeaders 删除（我们将重新添加）
  if (cookies.length > 0) respHeaders.delete("Set-Cookie");

  const fixedCookies = cookies.map(cookieStr => {
    // 查找原始 cookie 的 domain 来源：尝试通过上游 response url host 映射（保守方法）
    // 更好的策略是根据上游请求目标 host 来决定替换策略
    const upstreamHost = new URL(ORIGIN).host;
    // 如果 cookie 中存在 domain=，替换或删除
    let replaced = cookieStr;
    const domainMatch = /;\s*domain=([^;]+)/i.exec(cookieStr);
    if (domainMatch) {
      const origDomain = domainMatch[1].toLowerCase();
      // 查找 COOKIE_DOMAIN_MAP 中是否对 origDomain 或上游Host 有配置（允许模糊匹配末尾）
      let mapped = null;
      for (const [k, v] of Object.entries(COOKIE_DOMAIN_MAP)) {
        if (origDomain === k || origDomain.endsWith("." + k)) {
          mapped = v; break;
        }
      }
      // 如果没有找到，也看看上游 host 是否在表中
      if (!mapped && COOKIE_DOMAIN_MAP[upstreamHost]) mapped = COOKIE_DOMAIN_MAP[upstreamHost];

      if (mapped === "") {
        // 移除 domain= 部分
        replaced = replaced.replace(/;\s*domain=[^;]+/i, "");
      } else if (mapped) {
        // 替换为 mapped
        replaced = replaced.replace(/(;\s*domain=)([^;]+)/i, `$1${mapped}`);
      } else {
        // 不做替换，或移除 domain 以让 cookie 归属当前域（可选）
        replaced = replaced.replace(/;\s*domain=[^;]+/i, "");
      }
    } else {
      // 没有 domain 字段，则可以选择附加 domain（不建议） — 这里保持不变
    }
    return replaced;
  });

  // 3) 对响应体（如果是 HTML 或其他文本类型）进行 URL 替换
  // 只对 text/html / text/css / application/javascript 等常见文本类型进行处理
  const contentType = (respHeaders.get("content-type") || "").toLowerCase();
  const isHtml = contentType.includes("text/html");
  const isText = contentType.startsWith("text/") || contentType.includes("javascript") || contentType.includes("json");

  // 在 HTML 中我们使用 HTMLRewriter 来替换常见属性
  if (isHtml) {
    // 在返回的 headers 中删除或改写 CSP（如果存在）以免阻止 inline 脚本或资源
    // 这里示例简单删除 CSP，你可以根据需求改写
    if (respHeaders.has("content-security-policy")) respHeaders.delete("content-security-policy");

    // HTMLRewriter 规则：替换元素属性中的 URL（依据 HOST_MAP 和 ORIGIN）
    const rewriter = new HTMLRewriter()
      .on("a[href]", attrRewriter("href"))
      .on("link[href]", attrRewriter("href"))
      .on("img[src]", attrRewriter("src"))
      .on("script[src]", attrRewriter("src"))
      .on("source[src]", attrRewriter("src"))
      .on("source[srcset]", attrRewriter("srcset"))
      .on("img[srcset]", attrRewriter("srcset"))
      .on("form[action]", attrRewriter("action"))
      .on("meta[content]", {
        element(element) {
          const content = element.getAttribute("content");
          if (content) {
            const replaced = rewriteStringUrls(content);
            if (replaced !== content) element.setAttribute("content", replaced);
          }
        }
      });

    const transformedStream = rewriter.transform(upstreamResponse.body);

    // 构造最终 headers（将 fixedCookies 追加）
    const finalHeaders = new Headers(respHeaders);
    for (const c of fixedCookies) finalHeaders.append("Set-Cookie", c);

    return new Response(transformedStream, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: finalHeaders
    });
  }

  // 非 HTML：直接转发 body，但仍要处理 Set-Cookie 重写和 Location host 映射等
  const finalHeaders = new Headers(respHeaders);
  for (const c of fixedCookies) finalHeaders.append("Set-Cookie", c);

  // 对普通 header 中可能包含的外部 host（例如 link rel=preload 的 urls）做简单替换（可选、保守）
  for (const [k, v] of Array.from(finalHeaders.entries())) {
    if (typeof v === "string") {
      const newVal = rewriteStringUrls(v);
      if (newVal !== v) finalHeaders.set(k, newVal);
    }
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: finalHeaders
  });
}

/**
 * 工具函数：返回一个 HTMLRewriter handler，用于替换 element 的某个属性（如 href/src/srcset）
 */
function attrRewriter(attrName) {
  return {
    element(element) {
      const val = element.getAttribute(attrName);
      if (!val) return;
      const newVal = rewriteStringUrls(val);
      if (newVal !== val) element.setAttribute(attrName, newVal);
    }
  };
}

/**
 * 将字符串中的 URL 按规则替换：
 * - 如果 URL 属于 ORIGIN（上游），则改成本域的 /abc 前缀路径
 * - 否则，对 HOST_MAP 中的 host 做替换（仅替换 host 部分，不改变 path/query/hash）
 * 支持相对 URL、协议相对 URL，以及以逗号分隔的 srcset 格式
 */
function rewriteStringUrls(str) {
  // 处理 srcset（包含多个以逗号分隔的 URL [space] descriptor）
  if (str.includes(',')) {
    // 简单拆分并尝试处理每一项（注意：这不是完美的 srcset 解析，但适合常见情况）
    return str.split(',').map(part => {
      const p = part.trim();
      const sp = p.split(/\s+/); // ["url", "1x"]
      sp[0] = rewriteSingleUrl(sp[0]);
      return sp.join(' ');
    }).join(', ');
  } else {
    return rewriteSingleUrl(str);
  }
}

function rewriteSingleUrl(urlStr) {
  urlStr = urlStr.trim();
  // 如果是 data: / blob: 等不处理
  if (/^(data:|blob:|javascript:|#)/i.test(urlStr)) return urlStr;

  // 处理协议相对 //example.com/path
  if (urlStr.startsWith("//")) {
    const u = "https:" + urlStr;
    return mapUrl(u);
  }

  // 处理绝对 URL
  if (/^https?:\/\//i.test(urlStr)) {
    return mapUrl(urlStr);
  }

  // 以 / 开头的绝对路径（相对于上游站点）：把它前缀为 /abc
  if (urlStr.startsWith("/")) {
    // 若上游 ORIGIN_PATH 需要保留，去掉上游 path 前缀后加本地 prefix
    // e.g. /zrf/foo -> /abc/foo
    if (ORIGIN_PATH && urlStr.startsWith(ORIGIN_PATH)) {
      return `${LOCAL_PREFIX}${urlStr.slice(ORIGIN_PATH.length)}`;
    } else {
      return `${LOCAL_PREFIX}${urlStr}`;
    }
  }

  // 相对路径（不以 / 开头）——保持原样（浏览器会相对于当前页面解析），或根据需要也可加前缀（此处不改）
  return urlStr;
}

function mapUrl(absUrl) {
  try {
    const u = new URL(absUrl);
    // 如果属于 ORIGIN.host -> 映射到本域 LOCAL_PREFIX
    if (u.host === (new URL(ORIGIN)).host) {
      // keep path after ORIGIN_PATH
      let newPath = u.pathname;
      if (ORIGIN_PATH && newPath.startsWith(ORIGIN_PATH)) newPath = newPath.slice(ORIGIN_PATH.length);
      return `${new URL(self.location).origin}${LOCAL_PREFIX}${newPath}${u.search}${u.hash || ""}`;
    }
    // 否则检查 HOST_MAP
    for (const [k, v] of Object.entries(HOST_MAP)) {
      if (u.host === k || u.host.endsWith("." + k)) {
        // replace host part; keep scheme as is
        return `${u.protocol}//${v}${u.pathname}${u.search}${u.hash || ""}`;
      }
    }
    // 没有匹配，返回原始绝对 URL
    return absUrl;
  } catch (e) {
    return absUrl;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
