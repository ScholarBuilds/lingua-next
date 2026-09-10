/* Photoshop 生成面板：直接复用 Lingua 的模型部署、持久任务与工作流目录。 */
(function () {
  const net = DX.net;
  const ps = DX.ps;
  const state = DX.state;
  const $ = (id) => document.getElementById(id);
  const els = {
    modes: $('genModes'), apiBar: $('genApiBar'), provider: $('genProvider'), model: $('genModel'),
    rhBar: $('genRhBar'), rhWorkflow: $('genRhWorkflow'), rhWallet: $('genRhWallet'),
    comfyBar: $('genComfyBar'), comfyWorkflow: $('genComfyWorkflow'), prompt: $('genPrompt'),
    params: $('genParams'), refsSection: $('genRefsSection'), refs: $('genRefs'),
    results: $('genResults'), run: $('genRun'), msg: $('genMsg'),
  };
  const g = {
    mode: 'api', deployments: [], providerId: '', deploymentId: '',
    workflows: {runninghub: [], comfyui: []}, credentials: [], detail: null,
    values: {}, refs: [], results: [], addingRef: false, jobs: 0,
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  }
  function setMsg(text, kind = '') { els.msg.textContent = text || ''; els.msg.className = `push-msg ${kind}`; }
  function fieldId(field, index) {
    return field.id || `${field.node || field.nodeId || index}::${field.input || field.fieldName || index}`;
  }
  function fieldType(field) { return String(field.type || field.fieldType || 'text').toLowerCase(); }
  function isImageField(field) { return fieldType(field).indexOf('image') >= 0; }
  function currentDeployment() { return g.deployments.find((item) => String(item.id) === String(g.deploymentId)); }
  function currentWorkflow() {
    const provider = g.mode === 'rh' ? 'runninghub' : 'comfyui';
    const picker = g.mode === 'rh' ? els.rhWorkflow : els.comfyWorkflow;
    return g.workflows[provider].find((item) => String(item.id) === DX.ui.pickerValue(picker));
  }

  function setMode(mode) {
    g.mode = mode;
    els.modes.querySelectorAll('.seg').forEach((button) =>
      button.classList.toggle('active', button.getAttribute('data-mode') === mode));
    els.apiBar.classList.toggle('hidden', mode !== 'api');
    els.rhBar.classList.toggle('hidden', mode !== 'rh');
    els.comfyBar.classList.toggle('hidden', mode !== 'comfy');
    els.prompt.classList.remove('hidden');
    els.refsSection.classList.remove('hidden');
    g.detail = null; g.values = {}; els.params.innerHTML = '';
    if (mode === 'api') loadDeployments();
    else loadWorkflows(mode === 'rh' ? 'runninghub' : 'comfyui');
    updateRun();
  }

  async function loadDeployments() {
    setMsg('正在读取 Lingua 图片模型…');
    try {
      g.deployments = await net.apiGet('/api/config/model-deployments?media_type=image&enabled=true');
      const providers = [];
      const seen = {};
      g.deployments.forEach((deployment) => {
        const id = String(deployment.credential_id);
        if (seen[id]) return;
        seen[id] = true;
        providers.push({value: id, label: deployment.credential_name || deployment.provider_type || `凭据 ${id}`});
      });
      g.providerId = providers.some((item) => item.value === g.providerId) ? g.providerId : (providers[0] && providers[0].value || '');
      DX.ui.fillPicker(els.provider, providers, g.providerId);
      renderModels(); renderApiParams();
      setMsg(g.deployments.length ? '' : '没有已启用的图片模型，请先到 Lingua 设置中添加。', g.deployments.length ? '' : 'err');
    } catch (error) { setMsg(`加载图片模型失败：${error.message || error}`, 'err'); }
    updateRun();
  }

  function renderModels() {
    g.providerId = DX.ui.pickerValue(els.provider) || g.providerId;
    const models = g.deployments.filter((item) => String(item.credential_id) === String(g.providerId));
    if (!models.some((item) => String(item.id) === String(g.deploymentId))) g.deploymentId = models[0] ? String(models[0].id) : '';
    DX.ui.fillPicker(els.model, models.map((item) => ({
      value: String(item.id), label: item.display_name || item.upstream_model_id,
    })), g.deploymentId);
  }

  function renderApiParams() {
    els.params.innerHTML = `<div class="gen-row2">
      <label class="field-stack"><span class="gen-label">比例</span><select id="linguaRatio" class="gen-input">
        <option>1:1</option><option>3:4</option><option>4:3</option><option>16:9</option><option>9:16</option>
      </select></label>
      <label class="field-stack"><span class="gen-label">分辨率</span><select id="linguaTier" class="gen-input">
        <option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option>
      </select></label>
      <label class="field-stack"><span class="gen-label">数量</span><input id="linguaCount" class="gen-input" type="number" min="1" max="4" value="1"></label>
      <label class="field-stack"><span class="gen-label">质量</span><select id="linguaQuality" class="gen-input">
        <option value="medium">标准</option><option value="low">省费</option><option value="high">高质量</option>
      </select></label>
    </div>`;
  }

  async function loadWorkflows(provider) {
    setMsg(`正在读取 ${provider} 工作流…`);
    try {
      const [catalog, credentials] = await Promise.all([
        net.apiGet(`/api/studio/workflows?provider=${provider}&enabled=true`),
        net.apiGet('/api/config/credentials?kind=workflow'),
      ]);
      g.workflows[provider] = catalog.items || [];
      g.credentials = (credentials || []).filter((item) => item.enabled && item.provider_type === provider);
      const picker = provider === 'runninghub' ? els.rhWorkflow : els.comfyWorkflow;
      DX.ui.fillPicker(picker, g.workflows[provider].map((item) => ({value: String(item.id), label: item.title})), '');
      if (g.workflows[provider][0]) {
        DX.ui.fillPicker(picker, g.workflows[provider].map((item) => ({value: String(item.id), label: item.title})), String(g.workflows[provider][0].id));
        await loadWorkflowDetail();
      } else {
        setMsg('当前没有可用工作流。', 'err');
      }
    } catch (error) { setMsg(`加载工作流失败：${error.message || error}`, 'err'); }
    updateRun();
  }

  async function loadWorkflowDetail() {
    const workflow = currentWorkflow();
    if (!workflow) return;
    try {
      g.detail = await net.apiGet(`/api/studio/workflows/${workflow.id}`);
      g.values = {};
      const fields = (g.detail.ui_schema && g.detail.ui_schema.fields || []);
      fields.forEach((field, index) => { g.values[fieldId(field, index)] = field.default ?? field.fieldValue ?? ''; });
      renderWorkflowFields();
      setMsg(g.credentials.length ? '' : `没有已启用的 ${workflow.provider} 工作流凭据。`, g.credentials.length ? '' : 'err');
    } catch (error) { setMsg(`读取工作流参数失败：${error.message || error}`, 'err'); }
    updateRun();
  }

  function renderWorkflowFields() {
    const fields = (g.detail && g.detail.ui_schema && g.detail.ui_schema.fields || [])
      .filter((field) => field.hidden !== true && (g.detail.provider === 'comfyui' || field.enabled !== false));
    els.params.innerHTML = fields.map((field, index) => {
      const id = fieldId(field, index); const type = fieldType(field); const label = field.name || field.label || id;
      if (isImageField(field)) return `<div class="field-stack"><div class="gen-label">${esc(label)}</div><div class="size-hint">自动使用下方第 ${index + 1} 张参考图</div></div>`;
      if (type === 'boolean') return `<label class="gen-check"><input type="checkbox" data-wf="${esc(id)}"${g.values[id] ? ' checked' : ''}> ${esc(label)}</label>`;
      const options = Array.isArray(field.options) ? field.options : [];
      if (options.length) return `<label class="field-stack"><span class="gen-label">${esc(label)}</span><select class="gen-input" data-wf="${esc(id)}">${options.map((item) => `<option value="${esc(item)}"${String(item) === String(g.values[id]) ? ' selected' : ''}>${esc(item)}</option>`).join('')}</select></label>`;
      if (type === 'textarea') return `<label class="field-stack"><span class="gen-label">${esc(label)}</span><textarea class="gen-prompt" data-wf="${esc(id)}">${esc(g.values[id])}</textarea></label>`;
      return `<label class="field-stack"><span class="gen-label">${esc(label)}</span><input class="gen-input" data-wf="${esc(id)}" type="${type === 'number' || type === 'int' ? 'number' : 'text'}" value="${esc(g.values[id])}"${field.min == null ? '' : ` min="${esc(field.min)}"`}${field.max == null ? '' : ` max="${esc(field.max)}"`}></label>`;
    }).join('');
    els.params.querySelectorAll('[data-wf]').forEach((input) => input.addEventListener('input', () => {
      g.values[input.getAttribute('data-wf')] = input.type === 'checkbox' ? input.checked : (input.type === 'number' ? Number(input.value) : input.value);
    }));
  }

  function renderRefs() {
    els.refs.innerHTML = g.refs.map((item, index) => `<div class="ref-tile" title="${esc(item.name)}">
      <img src="${esc(net.absUrl(item.url))}" alt=""><div class="ref-num">${index + 1}</div>
      <div class="ref-x" data-ref-remove="${index}">×</div></div>`).join('') +
      `<div class="ref-add" id="refAddTile" title="加当前画面"><div class="ref-add-plus">＋</div><div class="ref-add-cap">加画面</div></div>`;
    els.refs.querySelector('#refAddTile').addEventListener('click', addCurrentLayer);
    els.refs.querySelectorAll('[data-ref-remove]').forEach((button) => button.addEventListener('click', () => {
      g.refs.splice(Number(button.getAttribute('data-ref-remove')), 1); renderRefs();
    }));
  }

  async function addCurrentLayer() {
    if (g.addingRef || !ps.hasDocument()) { if (!ps.hasDocument()) setMsg('没有打开的文档。', 'err'); return; }
    g.addingRef = true;
    try {
      setMsg('正在上传当前画面…');
      const {buffer, name} = await ps.exportCurrentPng();
      const imported = await net.importInputAsset(buffer, name);
      g.refs.push({asset_id: imported.asset_id, url: imported.asset.connector_url || imported.asset.full_url || imported.asset.url, name});
      renderRefs(); setMsg(`已添加参考图 ${g.refs.length}。`, 'ok');
    } catch (error) { setMsg(`添加参考图失败：${error.message || error}`, 'err'); }
    finally { g.addingRef = false; }
  }

  function renderResults() {
    els.results.innerHTML = g.results.map((item, index) => `<div class="gen-thumb result" data-result="${index}" title="${esc(item.name)}"><img src="${esc(net.absUrl(item.url))}" alt=""><div class="dl">下载到图层</div></div>`).join('');
    els.results.querySelectorAll('[data-result]').forEach((node) => node.addEventListener('click', () => placeOne(g.results[Number(node.getAttribute('data-result'))])));
  }
  async function placeOne(item) {
    try { await ps.placeImage({url: item.url, name: item.name, kind: 'image'}); setMsg(`已下载到图层：${item.name}`, 'ok'); }
    catch (error) { setMsg(`下载失败：${error.message || error}`, 'err'); }
  }
  function imageResult(asset) {
    return {
      name: asset.name || asset.prompt || `lingua-${asset.id}.png`,
      url: asset.connector_url || (asset.mime === 'image/png' || asset.mime === 'image/jpeg'
        ? asset.full_url || asset.url
        : `/api/studio/connectors/images/${asset.id}/jpeg`),
    };
  }
  async function acceptImages(assets) {
    const items = (assets || []).filter((item) => item && (item.kind === 'image' || item.asset_id || item.full_url)).map(imageResult);
    g.results = g.results.concat(items); renderResults();
    let placed = 0;
    for (const item of items) { try { await ps.placeImage({url: item.url, name: item.name, kind: 'image'}); placed += 1; } catch (error) {} }
    return placed;
  }

  function apiOptions() {
    const ratio = $('linguaRatio') ? $('linguaRatio').value : '1:1';
    const tier = $('linguaTier') ? $('linguaTier').value : '1k';
    const base = { '1k': 1024, '2k': 2048, '4k': 4096 }[tier] || 1024;
    const parts = ratio.split(':').map(Number); const rw = parts[0] || 1; const rh = parts[1] || 1;
    const align = (value) => Math.max(64, Math.round(value / 16) * 16);
    const width = rw >= rh ? base : align(base * rw / rh);
    const height = rh >= rw ? base : align(base * rh / rw);
    return {
      size: `${width}x${height}`,
      n: Math.max(1, Math.min(4, Number($('linguaCount') && $('linguaCount').value || 1))),
      quality: $('linguaQuality') ? $('linguaQuality').value : 'medium',
    };
  }

  async function runApi() {
    const prompt = els.prompt.value.trim(); const deployment = currentDeployment();
    if (!prompt || !deployment) return;
    const options = apiOptions();
    g.jobs += 1; setMsg(`生成中…（${g.jobs} 个任务）`);
    try {
      if (g.refs.length) {
        const created = await net.apiSend('POST', '/api/studio/connectors/edit-job', {
          prompt, deployment_id: deployment.id, ref_asset_ids: g.refs.map((item) => item.asset_id), ...options,
        });
        const task = await waitTask(created.studio_task_id);
        const ids = task.result && task.result.asset_ids || [];
        const assets = [];
        for (const id of ids) assets.push(await net.apiGet(`/api/images/assets/${id}`));
        const placed = await acceptImages(assets); setMsg(`已生成并下载 ${placed} 张到图层。`, 'ok');
      } else {
        const created = await net.apiSend('POST', '/api/images/jobs', {
          target_key: 'free', prompt_override: prompt, deployment_id: deployment.id,
          tool_id: 'photoshop-connector', source_route: '/studio/canvas', ...options,
        });
        const job = await waitImageJob(created.image_job_id);
        const placed = await acceptImages(job.assets || []); setMsg(`已生成并下载 ${placed} 张到图层。`, 'ok');
      }
    } catch (error) { setMsg(`生成失败：${error.message || error}`, 'err'); }
    finally { g.jobs = Math.max(0, g.jobs - 1); }
  }

  async function runWorkflow() {
    const workflow = currentWorkflow();
    if (!workflow) return;
    const credential = g.credentials.find((item) => item.provider_type === workflow.provider);
    if (!credential) { setMsg(`没有可用的 ${workflow.provider} 凭据。`, 'err'); return; }
    const fields = {}; let refIndex = 0;
    (g.detail.ui_schema && g.detail.ui_schema.fields || []).forEach((field, index) => {
      if (g.detail.provider !== 'comfyui' && field.enabled === false) return;
      const id = fieldId(field, index);
      if (isImageField(field)) {
        const ref = g.refs[refIndex++]; if (ref) fields[id] = `asset:${ref.asset_id}`;
      } else {
        let value = g.values[id];
        if ((value === '' || value == null) && field.bind_prompt === true) value = els.prompt.value.trim();
        if (field.random_enabled === true) value = Math.floor(Math.random() * 4294967296);
        if (value !== undefined) fields[id] = value;
      }
    });
    g.jobs += 1; setMsg(`工作流运行中…（${g.jobs} 个任务）`);
    try {
      const task = await net.apiSend('POST', `/api/studio/workflows/${workflow.id}/runs`, {
        credential_id: credential.id, fields, use_wallet: workflow.provider === 'runninghub' && els.rhWallet.checked,
        source_route: '/studio/canvas', source_context: {connector: 'photoshop'},
      });
      const completed = await waitTask(task.id);
      const items = completed.result && completed.result.items || [];
      const placed = await acceptImages(items.filter((item) => item.kind === 'image'));
      setMsg(placed ? `工作流完成，已下载 ${placed} 张到图层。` : '工作流完成，结果已进入 Lingua 素材库。', 'ok');
    } catch (error) { setMsg(`工作流失败：${error.message || error}`, 'err'); }
    finally { g.jobs = Math.max(0, g.jobs - 1); }
  }

  async function waitImageJob(id) {
    for (let index = 0; index < 900; index += 1) {
      const job = await net.apiGet(`/api/images/jobs/${id}`);
      if (job.status === 'success' || job.status === 'succeeded') return job;
      if (job.status === 'failed') throw new Error(job.error || '图片任务失败');
      await new Promise((resolve) => setTimeout(resolve, 1600));
    }
    throw new Error('图片任务超时');
  }
  async function waitTask(id) {
    for (let index = 0; index < 1200; index += 1) {
      const task = await net.apiGet(`/api/studio/tasks/${id}`);
      if (task.status === 'succeeded' || task.status === 'partial') return task;
      if (task.status === 'failed' || task.status === 'cancelled') throw new Error(task.error || '任务失败');
      await new Promise((resolve) => setTimeout(resolve, 1600));
    }
    throw new Error('任务超时');
  }

  function updateRun() {
    const promptOk = els.prompt.value.trim().length > 0;
    els.run.disabled = !state.connected || (g.mode === 'api'
      ? !promptOk || !currentDeployment()
      : !currentWorkflow() || !g.credentials.some((item) => item.provider_type === currentWorkflow().provider));
  }

  els.modes.querySelectorAll('.seg').forEach((button) => button.addEventListener('click', () => {
    if (state.connected) setMode(button.getAttribute('data-mode'));
  }));
  DX.ui.onPick(els.provider, () => { g.providerId = DX.ui.pickerValue(els.provider); renderModels(); updateRun(); });
  DX.ui.onPick(els.model, () => { g.deploymentId = DX.ui.pickerValue(els.model); updateRun(); });
  DX.ui.onPick(els.rhWorkflow, loadWorkflowDetail);
  DX.ui.onPick(els.comfyWorkflow, loadWorkflowDetail);
  els.prompt.addEventListener('input', updateRun);
  els.run.addEventListener('click', () => { if (g.mode === 'api') runApi(); else runWorkflow(); });
  renderRefs(); renderResults();

  DX.generate = {
    ensureLoaded() { if (state.connected) setMode(g.mode); },
    reset() {
      g.deployments = []; g.providerId = ''; g.deploymentId = '';
      g.workflows = {runninghub: [], comfyui: []}; g.credentials = []; g.detail = null;
      g.values = {}; g.refs = []; g.results = []; g.jobs = 0;
      renderRefs(); renderResults(); updateRun();
    },
  };
})();
