/* Lingua 统一素材源适配器。三个视图共用 /api/studio/connectors/catalog，
 * 不再依赖 Infinite-Canvas 的本地目录与 asset-library JSON 文件。 */
(function () {
  const state = DX.state;
  const net = DX.net;

  async function loadCatalog() {
    return net.apiGet('/api/studio/connectors/catalog');
  }

  function itemIsImage(item) {
    return Boolean(item && (item.kind === 'image' || String(item.mime || '').startsWith('image/')));
  }

  function searchText(item) {
    const tags = Array.isArray(item.tags) ? item.tags.join(' ') : '';
    return `${item.name || ''} ${item.prompt || ''} ${item.caption || ''} ${tags}`.toLowerCase();
  }

  function groups(catalog) {
    return [{id: '__all__', name: '全部分组'}].concat(
      (catalog && catalog.groups || []).map((group) => ({
        id: String(group.id),
        name: `${group.name || '未命名分组'} · ${group.count || 0}`,
      }))
    );
  }

  function inGroup(item, groupId) {
    return !groupId || groupId === '__all__' || String(item.group_id || '') === String(groupId);
  }

  function imageItem(item) {
    return {
      ...item,
      id: `image-${item.id}`,
      name: item.prompt || `图片 ${item.id}`,
      kind: 'image',
      url: item.connector_url || item.full_url || item.url,
      search: searchText(item),
    };
  }

  function mediaItem(item) {
    return {...item, id: `media-${item.id}`, search: searchText(item)};
  }

  async function exportPng(groupId, name, buffer) {
    const data = await net.apiSend('POST', '/api/studio/connectors/import', {
      group_id: groupId && groupId !== '__all__' ? Number(groupId) : null,
      items: [{
        data: `data:image/png;base64,${net.toBase64(buffer)}`,
        name,
        content_type: 'image/png',
      }],
    });
    const result = (data.items || [])[0];
    if (!result || result.ok === false) throw new Error(result && result.reason || '上传失败');
  }

  const adapters = {
    assets: {
      editable: true,
      async load() { state.raw.assets = await loadCatalog(); },
      optionsA() { return [{id: 'lingua', name: 'Lingua 图片资产'}]; },
      optionsB() { return groups(state.raw.assets); },
      items(_aId, bId) {
        return (state.raw.assets && state.raw.assets.images || [])
          .filter((item) => inGroup(item, bId))
          .map(imageItem);
      },
      exportTarget(_aId, bId) {
        const group = groups(state.raw.assets).find((item) => item.id === bId);
        return {label: group ? group.name : '未分组'};
      },
      async doExport(_aId, bId, name, buffer) { await exportPng(bId, name, buffer); },
    },

    canvas: {
      editable: false,
      async load() { state.raw.canvas = await loadCatalog(); },
      optionsA() { return [{id: '__all__', name: '全部画布'}]; },
      optionsB() {
        const canvases = state.raw.canvas && state.raw.canvas.canvases || [];
        return [{id: '__all__', name: '全部画布'}].concat(
          canvases.map((canvas) => ({id: String(canvas.id), name: `${canvas.title} · ${canvas.node_count || 0}`}))
        );
      },
      items(_aId, bId) {
        return (state.raw.canvas && state.raw.canvas.canvas_assets || [])
          .filter((item) => bId === '__all__' || String(item.canvas_id) === String(bId))
          .map((item, index) => ({
            ...item,
            id: `canvas-${item.canvas_id}-${item.node_id}-${item.id}-${index}`,
            name: item.node_title || item.name || item.prompt || `${item.canvas_title} 素材`,
            kind: item.kind || 'image',
            url: item.connector_url || item.full_url || item.url,
            search: `${searchText(item)} ${item.canvas_title || ''} ${item.node_title || ''}`.toLowerCase(),
          }));
      },
      exportTarget() { return null; },
    },

    local: {
      editable: true,
      async load() { state.raw.local = await loadCatalog(); },
      optionsA() { return null; },
      optionsB() { return groups(state.raw.local); },
      items(_aId, bId) {
        const catalog = state.raw.local || {};
        const connectorImages = (catalog.images || [])
          .filter((item) => item.source === 'connector' && inGroup(item, bId))
          .map(imageItem);
        const media = (catalog.media || []).filter((item) => inGroup(item, bId)).map(mediaItem);
        return connectorImages.concat(media);
      },
      exportTarget(_aId, bId) {
        const group = groups(state.raw.local).find((item) => item.id === bId);
        return {label: group ? group.name : '未分组'};
      },
      async doExport(_aId, bId, name, buffer) { await exportPng(bId, name, buffer); },
    },
  };

  DX.sources = {
    adapters,
    adapter() { return adapters[state.source]; },
    itemIsImage,
    classificationText() { return ''; },
  };
})();
