/* 网络层：地址解析、HTTP/WS base、REST 助手、字节上传。纯逻辑，不碰 DOM/PS。 */
(function () {
  const state = DX.state;

  function parseHost(raw) {
    let text = String(raw || '').trim();
    if (!text) return '';
    text = text.replace(/^[a-z]+:\/\//i, '').replace(/[\/\?#].*$/, '');
    return text.trim();
  }

  function httpBase() { return state.host ? `http://${state.host}` : ''; }
  function wsBase() { return state.host ? `ws://${state.host}` : ''; }

  function absUrl(url) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    const base = httpBase();
    if (!base) return url;
    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  // 连接器页面要显示「已连接 / 未连接」，判据只能是面板自己说过话。
  // 只给 /studio/connectors 下的请求挂身份，别的端点不该收到多余参数。
  function connectorQuery() {
    return `connector=${DX.CONNECTOR_ID}&connector_version=${encodeURIComponent(DX.VERSION)}`;
  }

  function withConnector(path) {
    if (!/^\/api\/studio\/connectors(\/|$|\?)/.test(path)) return path;
    return `${path}${path.includes('?') ? '&' : '?'}${connectorQuery()}`;
  }

  // 面板开着就按固定间隔报一次；关掉自然停，后端超时后如实转成未连接。
  async function heartbeat() {
    if (!state.host) return;
    // 没启服务、地址填错都属常态，静默失败，别打断正在做的事
    try { await fetch(`${httpBase()}/api/studio/connectors/status?${connectorQuery()}`, { cache: 'no-store' }); }
    catch (e) {}
  }

  async function apiGet(path) {
    const res = await fetch(`${httpBase()}${withConnector(path)}`, { cache: 'no-store' });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    try { return JSON.parse(text || '{}'); }
    catch (e) { throw new Error(`返回不是 JSON：${text.slice(0, 120)}`); }
  }

  async function apiSend(method, path, body) {
    const res = await fetch(`${httpBase()}${withConnector(path)}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    return JSON.parse(text || '{}');
  }

  // catalog 已把 UXP 不支持的图片指向 Lingua JPEG 转码端点。
  const UXP_UNSUPPORTED = /\.(webp|bmp|avif|tiff?|heic|heif)(\?|#|$)/i;
  function needsJpeg(url) { return UXP_UNSUPPORTED.test(String(url || '').split(/[?#]/)[0]); }
  function displayUrl(url, w) {
    return absUrl(url);
  }

  // 连接器目录返回的 URL 本身就是可缓存的预览/转码地址。
  function thumbUrl(url, w) {
    return absUrl(url);
  }

  async function fetchBytes(url) {
    const res = await fetch(absUrl(url));
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  // ArrayBuffer → base64（手写，不依赖 btoa；分块避免大图爆栈）
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = '';
    let i = 0;
    const n = bytes.length;
    for (; i + 2 < n; i += 3) {
      const t = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[(t >> 18) & 63] + B64[(t >> 12) & 63] + B64[(t >> 6) & 63] + B64[t & 63];
    }
    const rem = n - i;
    if (rem === 1) {
      const t = bytes[i] << 16;
      out += B64[(t >> 18) & 63] + B64[(t >> 12) & 63] + '==';
    } else if (rem === 2) {
      const t = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64[(t >> 18) & 63] + B64[(t >> 12) & 63] + B64[(t >> 6) & 63] + '=';
    }
    return out;
  }

  // UXP 的 FormData 支持不稳定，统一用 JSON base64 进 Lingua 资产库。
  async function importBase64Asset(b64, name, mime) {
    if (!b64) throw new Error('图片为空，无法上传');
    const contentType = mime || 'image/png';
    const data = await apiSend('POST', '/api/studio/connectors/import', {
      items: [{data: `data:${contentType};base64,${b64}`, name, content_type: contentType}],
    });
    const result = (data.items || [])[0];
    if (result && result.ok && result.asset) return result;
    throw new Error((result && result.reason) || '上传失败，后端未返回资产');
  }

  async function uploadBase64Raw(b64, name, mime) {
    const result = await importBase64Asset(b64, name, mime);
    return result.asset.connector_url || result.asset.full_url || result.asset.url;
  }

  // 用 base64 JSON 上传 PNG 字节（buffer 版），返回 /assets 地址。
  async function uploadInputBase64(buffer, name) {
    return uploadBase64Raw(toBase64(buffer), name, 'image/png');
  }

  async function importInputAsset(buffer, name) {
    return importBase64Asset(toBase64(buffer), name, 'image/png');
  }

  DX.net = { parseHost, httpBase, wsBase, absUrl, connectorQuery, withConnector, heartbeat, thumbUrl, displayUrl, needsJpeg, apiGet, apiSend, fetchBytes, toBase64, importBase64Asset, uploadInputBase64, importInputAsset, uploadBase64Raw };
})();
