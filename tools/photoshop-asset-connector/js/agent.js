/* Lingua GPT 创作对话：会话、模型路由和生成资产全部复用 Web 端现有接口。 */
(function () {
  const net = DX.net;
  const ps = DX.ps;
  const state = DX.state;
  const $ = (id) => document.getElementById(id);
  const els = {
    newBtn: $('agNew'), deleteBtn: $('agDelete'), history: $('agHistory'),
    toggleModels: $('agToggleModels'), messages: $('agMessages'), attach: $('agAttach'),
    attachBtn: $('agAttachBtn'), regionBtn: $('agRegionBtn'), retryBtn: $('agRetryBtn'),
    input: $('agInput'), send: $('agSend'), status: $('agStatus'),
  };
  const a = {
    loaded: false, busy: false, chats: [], chatId: '', turns: [], attachments: [],
    lastInput: '', regionMode: false, placeBounds: null,
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  }
  function setStatus(text, kind = '') {
    els.status.textContent = text || '';
    els.status.className = `push-msg ${kind}`;
  }
  function imageUrl(assetId) {
    return `/api/studio/connectors/images/${assetId}/jpeg`;
  }
  function normalizeTurn(turn) {
    return {
      role: turn.role,
      text: turn.content || '',
      assetIds: turn.role === 'user' ? (turn.image_asset_ids || []) : (turn.asset_ids || []),
      error: turn.error || '',
    };
  }

  function renderMessages() {
    if (!a.turns.length) {
      els.messages.innerHTML = '<div class="empty-state">直接描述想画或想改的内容。需要参考当前 Photoshop 画面时，先点输入框左侧的「＋」。</div>';
      return;
    }
    els.messages.innerHTML = a.turns.map((turn) => {
      const images = (turn.assetIds || []).map((id) => `<div class="agent-imgtile">
        <img src="${esc(net.absUrl(imageUrl(id)))}" alt="">
        <button class="agent-dl" type="button" data-addasset="${id}" title="下载到图层">下载</button>
      </div>`).join('');
      const text = turn.text ? `<div class="agent-text">${esc(turn.text)}</div>` : '';
      const error = turn.error ? `<div class="agent-note">${esc(turn.error)}</div>` : '';
      return `<div class="agent-msg ${esc(turn.role)}">${text}${error}${images}</div>`;
    }).join('');
    els.messages.querySelectorAll('[data-addasset]').forEach((button) => button.addEventListener('click', async () => {
      const id = Number(button.getAttribute('data-addasset'));
      try {
        await ps.placeImage({url: imageUrl(id), name: `lingua-agent-${id}.jpg`, kind: 'image'});
        setStatus('已下载到 Photoshop 图层。', 'ok');
      } catch (error) { setStatus(`下载失败：${error.message || error}`, 'err'); }
    }));
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function renderAttachments() {
    els.attach.innerHTML = a.attachments.map((item, index) => `<div class="ref-tile" title="${esc(item.name)}">
      <img src="${esc(net.absUrl(item.url))}" alt=""><div class="ref-num">${index + 1}</div>
      <button class="ref-x" type="button" data-remove="${index}">×</button>
    </div>`).join('');
    els.attach.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => {
      a.attachments.splice(Number(button.getAttribute('data-remove')), 1);
      renderAttachments(); updateSend();
    }));
  }

  function updateSend() {
    els.send.disabled = !state.connected || a.busy || !els.input.value.trim();
    els.newBtn.disabled = a.busy || !state.connected;
    els.deleteBtn.disabled = a.busy || !a.chatId;
    els.attachBtn.disabled = a.busy || !state.connected || !ps.hasDocument();
    els.retryBtn.disabled = a.busy || !a.lastInput;
  }

  async function loadChats(preferredId) {
    const payload = await net.apiGet('/api/studio/gpt-chats');
    a.chats = payload.items || [];
    if (preferredId != null) a.chatId = String(preferredId);
    if (!a.chats.some((item) => String(item.id) === String(a.chatId))) {
      a.chatId = a.chats[0] ? String(a.chats[0].id) : '';
    }
    DX.ui.fillPicker(els.history, a.chats.map((item) => ({
      value: String(item.id), label: `${item.pinned ? '★ ' : ''}${item.title} · ${Math.floor(item.turn_count / 2)} 轮`,
    })), a.chatId);
    if (a.chatId) await loadConversation(a.chatId);
    else { a.turns = []; renderMessages(); }
    updateSend();
  }

  async function loadConversation(id) {
    if (!id) return;
    const detail = await net.apiGet(`/api/studio/gpt-chats/${id}`);
    a.chatId = String(detail.id);
    a.turns = (detail.turns || []).map(normalizeTurn);
    renderMessages(); updateSend();
  }

  async function createConversation() {
    const detail = await net.apiSend('POST', '/api/studio/gpt-chats', {title: 'Photoshop 对话'});
    a.turns = []; a.attachments = []; a.placeBounds = null;
    renderAttachments();
    await loadChats(detail.id);
    els.input.focus();
  }

  async function deleteConversation() {
    if (!a.chatId || a.busy) return;
    try {
      await net.apiSend('DELETE', `/api/studio/gpt-chats/${a.chatId}`, {});
      a.chatId = ''; a.turns = [];
      await loadChats();
      setStatus('对话已删除。', 'ok');
    } catch (error) { setStatus(`删除失败：${error.message || error}`, 'err'); }
  }

  async function addCurrentView() {
    if (a.busy || !ps.hasDocument()) { setStatus('请先打开 Photoshop 文档。', 'err'); return; }
    try {
      setStatus(a.regionMode ? '正在读取当前选区…' : '正在上传当前画面…');
      let imported;
      if (a.regionMode) {
        const selected = await ps.exportSelectionPng();
        if (!selected) throw new Error('没有有效选区，请先用矩形选框框出要修改的位置');
        imported = await net.importBase64Asset(selected.base64, `${selected.name}.jpg`, selected.mime);
        a.placeBounds = selected.bounds;
      } else {
        const exported = await ps.exportCurrentPng();
        imported = await net.importInputAsset(exported.buffer, `${exported.name}.png`);
        a.placeBounds = null;
      }
      const asset = imported.asset;
      if (!a.attachments.some((item) => item.assetId === imported.asset_id)) {
        a.attachments.push({
          assetId: imported.asset_id,
          name: asset.name || asset.prompt || `参考图 ${imported.asset_id}`,
          url: asset.connector_url || asset.full_url || asset.url || imageUrl(imported.asset_id),
        });
      }
      renderAttachments(); updateSend();
      setStatus(`已添加参考图 ${a.attachments.length}/4。`, 'ok');
    } catch (error) { setStatus(`添加参考图失败：${error.message || error}`, 'err'); }
  }

  function parseEvents(text) {
    const events = [];
    String(text || '').split(/\r?\n\r?\n/).forEach((frame) => {
      const line = frame.split(/\r?\n/).find((item) => item.indexOf('data:') === 0);
      if (!line) return;
      try { events.push(JSON.parse(line.slice(5).trim())); } catch (error) {}
    });
    return events;
  }

  async function send() {
    const text = els.input.value.trim();
    if (!text || a.busy || !state.connected) return;
    a.busy = true; a.lastInput = text; updateSend();
    try {
      if (!a.chatId) await createConversation();
      const refIds = a.attachments.slice(0, 4).map((item) => item.assetId);
      a.turns.push({role: 'user', text, assetIds: refIds});
      const assistant = {role: 'assistant', text: '', assetIds: [], error: ''};
      a.turns.push(assistant);
      els.input.value = ''; renderMessages();
      setStatus('Lingua Agent 正在处理；生图会使用 Web 端的 chat-general / image-free 绑定…');
      const response = await fetch(`${net.httpBase()}/api/studio/gpt-chats/${a.chatId}/send`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text, image_asset_ids: refIds}),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status} ${body.slice(0, 160)}`);
      parseEvents(body).forEach((event) => {
        if (event.type === 'delta') assistant.text += event.text || '';
        if (event.type === 'image' && !assistant.assetIds.includes(event.asset_id)) assistant.assetIds.push(event.asset_id);
        if (event.type === 'error') assistant.error = event.detail || '对话失败';
        if (event.type === 'done' && event.turn) {
          assistant.text = event.turn.content || assistant.text;
          assistant.assetIds = event.turn.asset_ids || assistant.assetIds;
          assistant.error = event.turn.error || assistant.error;
        }
      });
      renderMessages();
      let placed = 0;
      for (const id of assistant.assetIds) {
        try {
          const item = {url: imageUrl(id), name: `lingua-agent-${id}.jpg`, kind: 'image'};
          if (a.placeBounds) await ps.placeImageAt(item, a.placeBounds);
          else await ps.placeImage(item);
          placed += 1;
        } catch (error) {}
      }
      a.attachments = []; a.placeBounds = null; renderAttachments();
      await loadChats(a.chatId);
      setStatus(assistant.error
        ? `本轮完成但有错误：${assistant.error}`
        : assistant.assetIds.length ? `已生成 ${assistant.assetIds.length} 张，下载 ${placed} 张到图层。` : '对话完成。',
      assistant.error ? 'err' : 'ok');
    } catch (error) {
      a.turns.push({role: 'assistant', text: '', assetIds: [], error: String(error.message || error)});
      renderMessages(); setStatus(`发送失败：${error.message || error}`, 'err');
    } finally { a.busy = false; updateSend(); }
  }

  els.newBtn.addEventListener('click', () => createConversation().catch((error) => setStatus(`新建失败：${error.message || error}`, 'err')));
  els.deleteBtn.addEventListener('click', deleteConversation);
  DX.ui.onPick(els.history, () => loadConversation(DX.ui.pickerValue(els.history)).catch((error) => setStatus(`载入失败：${error.message || error}`, 'err')));
  els.toggleModels.addEventListener('click', () => ps.openUrl(`${net.httpBase()}/settings`).catch((error) => setStatus(`打开设置失败：${error.message || error}`, 'err')));
  els.attachBtn.addEventListener('click', addCurrentView);
  els.regionBtn.addEventListener('click', () => {
    a.regionMode = !a.regionMode;
    els.regionBtn.classList.toggle('active', a.regionMode);
    setStatus(a.regionMode ? '选区模式已开启：点「＋」会读取矩形选区，生成结果也会贴回该位置。' : '已关闭选区模式。', a.regionMode ? 'ok' : '');
  });
  els.retryBtn.addEventListener('click', () => { if (a.lastInput && !a.busy) { els.input.value = a.lastInput; updateSend(); send(); } });
  els.input.addEventListener('input', updateSend);
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  });
  els.send.addEventListener('click', send);
  renderMessages(); renderAttachments(); updateSend();

  DX.agent = {
    async ensureLoaded() {
      if (!state.connected || a.loaded) return;
      a.loaded = true;
      try { await loadChats(); setStatus('Agent 已连接 Lingua 持久对话。', 'ok'); }
      catch (error) { a.loaded = false; setStatus(`加载对话失败：${error.message || error}`, 'err'); }
    },
    reset() {
      a.loaded = false; a.busy = false; a.chats = []; a.chatId = ''; a.turns = [];
      a.attachments = []; a.placeBounds = null;
      renderMessages(); renderAttachments(); updateSend();
    },
  };
})();
