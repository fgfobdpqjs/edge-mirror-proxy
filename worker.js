addEventListener("fetch", event => {
  event.respondWith(handle(event.request));
});

/**
 * 配置优先级说明
 * - 首选使用 Worker 环境绑定（Bindings / Environment Variables）。
 * - 如果环境绑定不存在或无效，则回退到下面的硬编码默认值（你此前脚本中的值）。
 *
 * 绑定名建议（在 Cloudflare Workers Dashboard / wrangler.toml 中配置）：
 * - ORIGIN                (string)  e.g. "https://expmale.com"
 * - ORIGIN_PATH           (string)  e.g. "/"
 * - LOCAL_PREFIX          (string)  e.g. "/a"
 * - HOST_MAP_JSON         (string)  JSON 字符串: {"github.com":"facebook.com", ...}
 * - COOKIE_DOMAIN_MAP_JSON(string)  JSON 字符串: {"x.com":"youtube.com", ...}
 *
 * 注意：Cloudflare 在绑定字符串时会把它们作为全局变量注入脚本作用域（非 module 模式）。
 * 如果你使用 Wrangler 的 environment/vars，请把上面名字对应的值绑定到 Worker。
 */

/* --- 硬编码默认值（仅作 fallback） --- */
const DEFAULT_ORIGIN = "https://expmale.com";
const DEFAULT_ORIGIN_PATH = "/";
const DEFAULT_LOCAL_PREFIX = "/a";
const DEFAULT_HOST_MAP = {
  "github.com": "facebook.com",
  "google.com": "microsoft.com"
};
const DEFAULT_COOKIE_DOMAIN_MAP = {
  "x.com": "youtube.com",
  "discord.com": "tiktok.com"
};

/* --- 从环境变量读取（优先）并回退到默认值 --- */
function readStringBinding(name, fallback) {
  try {
    // global binding variables (Cloudflare injects them into global scope)
    if (typeof globalThis[name] !== "undefined" && globalThis[name] !== null) {
      return String(globalThis[name]);
    }
  } catch (e) {
    // ignore
  }
  return fallback;
}

function readJSONBinding(name, fallbackObj) {
  const s = readStringBinding(name, null);
  if (!s) return fallbackObj;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (e) {
    // if parsing fails, ignore and use fallback
  }
  return fallbackObj;
}

/* 使用绑定（若存在）或默认值 */
const ORIGIN = readStringBinding("ORIGIN", DEFAULT_ORIGIN);
const ORIGIN_PATH = readStringBinding("ORIGIN_PATH", DEFAULT_ORIGIN_PATH);
const LOCAL_PREFIX = readStringBinding("LOCAL_PREFIX", DEFAULT_LOCAL_PREFIX);
const HOST_MAP = readJSONBinding("HOST_MAP_JSON", DEFAULT_HOST_MAP);
const COOKIE_DOMAIN_MAP = readJSONBinding("COOKIE_DOMAIN_MAP_JSON", DEFAULT_COOKIE_DOMAIN_MAP);

/* 工具：判断 URL 是否属于 ORIGIN host */
function shouldMapToLocal(url) {
  try {
    const u = new URL(url, ORIGIN);
    return u.host === (new URL(ORIGIN)).host;
  } catch (e) {
    return false;
  }
}

/* 主处理逻辑（保留你原始实现的核心） */
async function handle(request) {
  const reqUrl = new URL(request.url);
  const prefix = LOCAL_PREFIX;
  let suffix = reqUrl.pathname.startsWith(prefix) ? reqUrl.pathname.slice(prefix.length) : "";
  const targetUrl = new URL(ORIGIN + (ORIGIN_PATH || "") + suffix + reqUrl.search);

  const newHeaders = new Headers(request.headers);
  try { newHeaders.set("Host", new URL(ORIGIN).host); } catch (e) {}
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

  const respHeaders = new Headers(upstreamResponse.headers);

  // Location 处理
  if (respHeaders.has("Location")) {
    const loc = respHeaders.get("Location");
    try {
      if (shouldMapToLocal(loc)) {
        const locUrl = new URL(loc, ORIGIN);
        const newLoc = `${new URL(request.url).origin}${prefix}${locUrl.pathname.replace(ORIGIN_PATH, "")}${locUrl.search}${locUrl.hash || ""}`;
        respHeaders.set("Location", newLoc);
      } else {
        let newLoc = loc;
        for (const [k, v] of Object.entries(HOST_MAP)) {
          const re = new RegExp(`(^https?:\/\/)(${escapeRegExp(k)})`, "i");
          newLoc = newLoc.replace(re, `$1${v}`);
        }
        respHeaders.set("Location", newLoc);
      }
    } catch (e) { /* ignore */ }
  }

  // Set-Cookie 处理
  const cookies = [];
  try {
    if (typeof upstreamResponse.headers.getAll === "function") {
      const sc = upstreamResponse.headers.getAll("Set-Cookie");
      if (sc && sc.length) sc.forEach(c => cookies.push(c));
    } else {
      const scRaw = upstreamResponse.headers.get("Set-Cookie");
      if (scRaw) scRaw.split(/\r?\n/).forEach(c => { if (c.trim()) cookies.push(c.trim()); });
    }
  } catch (e) {}

  if (cookies.length > 0) respHeaders.delete("Set-Cookie");

  const fixedCookies = cookies.map(cookieStr => {
    let replaced = cookieStr;
    const domainMatch = /;\s*domain=([^;]+)/i.exec(cookieStr);
    if (domainMatch) {
      const origDomain = domainMatch[1].toLowerCase();
      let mapped = null;
      for (const [k, v] of Object.entries(COOKIE_DOMAIN_MAP)) {
        if (origDomain === k || origDomain.endsWith("." + k)) { mapped = v; break; }
      }
      const upstreamHost = new URL(ORIGIN).host;
      if (!mapped && COOKIE_DOMAIN_MAP[upstreamHost]) mapped = COOKIE_DOMAIN_MAP[upstreamHost];

      if (mapped === "") {
        replaced = replaced.replace(/;\s*domain=[^;]+/i, "");
      } else if (mapped) {
        replaced = replaced.replace(/(;\s*domain=)([^;]+)/i, `$1${mapped}`);
      } else {
        replaced = replaced.replace(/;\s*domain=[^;]+/i, "");
      }
    }
    return replaced;
  });

  // 响应体替换（HTML）
  const contentType = (respHeaders.get("content-type") || "").toLowerCase();
  const isHtml = contentType.includes("text/html");

  if (isHtml) {
    if (respHeaders.has("content-security-policy")) respHeaders.delete("content-security-policy");

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

    const finalHeaders = new Headers(respHeaders);
    for (const c of fixedCookies) finalHeaders.append("Set-Cookie", c);

    return new Response(transformedStream, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: finalHeaders
    });
  }

  // 非 HTML：直接转发但处理 Set-Cookie & header 内替换
  const finalHeaders = new Headers(respHeaders);
  for (const c of fixedCookies) finalHeaders.append("Set-Cookie", c);

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

/* --- 辅助函数 --- */
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

function rewriteStringUrls(str) {
  if (!str) return str;
  if (str.includes(',')) {
    return str.split(',').map(part => {
      const p = part.trim();
      const sp = p.split(/\s+/);
      sp[0] = rewriteSingleUrl(sp[0]);
      return sp.join(' ');
    }).join(', ');
  } else {
    return rewriteSingleUrl(str);
  }
}

function rewriteSingleUrl(urlStr) {
  urlStr = urlStr.trim();
  if (/^(data:|blob:|javascript:|#)/i.test(urlStr)) return urlStr;

  if (urlStr.startsWith("//")) {
    const u = "https:" + urlStr;
    return mapUrl(u);
  }

  if (/^https?:\/\//i.test(urlStr)) {
    return mapUrl(urlStr);
  }

  if (urlStr.startsWith("/")) {
    if (ORIGIN_PATH && urlStr.startsWith(ORIGIN_PATH)) {
      return `${LOCAL_PREFIX}${urlStr.slice(ORIGIN_PATH.length)}`;
    } else {
      return `${LOCAL_PREFIX}${urlStr}`;
    }
  }

  return urlStr;
}

function mapUrl(absUrl) {
  try {
    const u = new URL(absUrl);
    if (u.host === (new URL(ORIGIN)).host) {
      let newPath = u.pathname;
      if (ORIGIN_PATH && newPath.startsWith(ORIGIN_PATH)) newPath = newPath.slice(ORIGIN_PATH.length);
      // 使用请求来源来替代 self.location，尽量兼容 runtime
      const origin = typeof GLOBAL_REQUEST_ORIGIN !== "undefined" ? GLOBAL_REQUEST_ORIGIN : "";
      // fallback: try location.origin if available
      const currentOrigin = origin || (typeof location !== "undefined" && location.origin) || "";
      return `${currentOrigin || ""}${LOCAL_PREFIX}${newPath}${u.search}${u.hash || ""}` || absUrl;
    }
    for (const [k, v] of Object.entries(HOST_MAP)) {
      if (u.host === k || u.host.endsWith("." + k)) {
        return `${u.protocol}//${v}${u.pathname}${u.search}${u.hash || ""}`;
      }
    }
    return absUrl;
  } catch (e) {
    return absUrl;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
