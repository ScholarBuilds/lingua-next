/* 资产/画布实时同步：后端基于持久化版本发送变化事件。
 * 抖动只影响自动刷新，不影响 REST 浏览、置入、上传和生成。 */
(function () {
  const state = DX.state;
  const net = DX.net;

  function openSocket(handlers) {
    closeSocket();
    if (!handlers.isLive()) return;
    let ws;
    try { ws = new WebSocket(`${net.wsBase()}/api/studio/connectors/events?${net.connectorQuery()}`); }
    catch (e) { return; }
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.wsBackoff = 1000;
      if (state.wsWasOpen) handlers.onUpdate();
      state.wsWasOpen = true;
    });
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch (e) { return; }
      if (!message || message.type === 'ready' || message.type === 'pong') return;
      if (message.type === 'asset_library_updated') {
        handlers.onUpdate('assets');
        handlers.onUpdate('local');
      } else if (message.type === 'canvas_updated') {
        handlers.onUpdate('canvas');
      }
    });
    ws.addEventListener('close', () => {
      if (state.ws !== ws) return;
      state.ws = null;
      if (state.connected && handlers.isLive()) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(() => openSocket(handlers), state.wsBackoff);
        state.wsBackoff = Math.min(state.wsBackoff * 2, 8000);
      }
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch (e) {} });
  }

  function closeSocket() {
    clearTimeout(state.reconnectTimer);
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
  }

  DX.socket = {openSocket, closeSocket};
})();
