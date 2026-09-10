/* 共享状态 + 本地持久化键。挂到全局 DX 命名空间（多 script 共享作用域）。 */
window.DX = window.DX || {};

/* 面板版本。UXP 运行时读不到自己的 manifest，只能写死；
   package_connectors 的测试会拦「和 manifest.json 对不上」。 */
DX.VERSION = '1.0.0';
DX.CONNECTOR_ID = 'photoshop';

DX.LS = {
  host: 'lingua.assets.host',
  source: 'lingua.assets.source',
  exportLayer: 'lingua.assets.exportLayer',
};

DX.state = {
  host: '',
  connected: false,
  tab: 'assets',                 // assets | generate | settings
  source: 'assets',              // assets | canvas | local
  raw: { assets: null, canvas: null, local: null },
  aId: '',
  bId: '',
  selectedId: '',
  exportLayer: false,
  // WebSocket
  ws: null,
  wsPing: null,
  wsBackoff: 1000,
  wsWasOpen: false,
  reconnectTimer: null,
  reloadTimer: null,
};
