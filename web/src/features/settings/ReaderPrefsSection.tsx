/* 阅读与外观：主题三态 / 双语译文样式 / 朗读跟随 / 右栏点词 / 自动发音 / 看板娘。
   全部写 prefStore（服务端整包 + localStorage 兜底），运行时 store 由 App 桥接同步 */

import { useQuery } from '@tanstack/react-query'

import { loadMascotManifest } from '../mascot/mascotStore'
import { usePrefStore } from '../../lib/prefStore'
import type { NavLayout, ThemePref, TransStyle } from '../../lib/prefStore'
import type { BreakdownMode } from '../../lib/prefStore'
import { CGroup, PrefRow, SecHead, Sel, Switch } from './shared'
import { useWorkspaceStore } from '@/lib/workspaceStore'
import { toast } from 'sonner'

const THEME_OPTIONS: Array<[ThemePref, string]> = [
  ['light', '浅色'],
  ['dark', '深色'],
  ['system', '跟随系统'],
]

const TRANS_OPTIONS: Array<[TransStyle, string]> = [
  ['muted', '弱化'],
  ['ink', '同色'],
  ['compact', '紧凑'],
]


/** 拆开记形式（FR-328） */
const BREAKDOWN_OPTIONS: Array<[BreakdownMode, string]> = [
  ['both', '音节 + 词根'],
  ['syllable', '只看音节'],
  ['morpheme', '只看词根'],
  ['off', '关闭'],
]
const NAV_OPTIONS: Array<[NavLayout, string]> = [
  ['side', '左侧栏'],
  ['top', '顶部栏'],
]

export function ReaderPrefsSection() {
  const prefs = usePrefStore((s) => s.prefs)
  const synced = usePrefStore((s) => s.synced)
  const update = usePrefStore((s) => s.update)

  const manifestQuery = useQuery({
    queryKey: ['mascot-manifest'],
    queryFn: loadMascotManifest,
    staleTime: Infinity,
    retry: false,
  })
  const models = manifestQuery.data ?? []
  const currentModel =
    models.find((m) => m.id === prefs.mascot.modelId) ?? models[0] ?? null

  return (
    <>
      <SecHead
        title="阅读与外观"
        desc="偏好保存在服务端（本地缓存兜底），换浏览器登录后自动跟随。"
      />

      <CGroup>外观</CGroup>
      <div className="card pref-card">
        <PrefRow name="记住工作位置" desc="菜单切换及重启后恢复子页面和阅读位置，不自动恢复播放或收音">
          <input type="checkbox" checked={prefs.ui.rememberPosition} aria-label="记住工作位置"
            onChange={e => update({ ui: { rememberPosition: e.target.checked } })} />
          <button className="btn btn-outline" onClick={() => {
            if (!window.confirm('清除页面位置及未提交草稿？学习记录不会删除。')) return
            void useWorkspaceStore.getState().clear().then(() => toast.success('页面记忆已清除')).catch(e => toast.error(String(e)))
          }}>清除页面记忆</button>
        </PrefRow>
        <PrefRow name="主题" desc="跟随系统时按操作系统的深浅色自动切换">
          <div className="seg">
            {THEME_OPTIONS.map(([key, label]) => (
              <button
                key={key}
                className={prefs.theme === key ? 'active' : undefined}
                onClick={() => update({ theme: key })}
              >
                {label}
              </button>
            ))}
          </div>
        </PrefRow>
        <PrefRow name="导航布局" desc="左侧栏为图标竖排；顶部栏水平排列，内容区更宽，切换即时生效">
          <div className="seg">
            {NAV_OPTIONS.map(([key, label]) => (
              <button
                key={key}
                className={prefs.ui.navLayout === key ? 'active' : undefined}
                onClick={() => update({ ui: { navLayout: key } })}
              >
                {label}
              </button>
            ))}
          </div>
        </PrefRow>
        <PrefRow name="双语译文样式" desc="阅读页句间译文的呈现：弱化灰 / 与正文同色 / 紧凑小字">
          <div className="seg">
            {TRANS_OPTIONS.map(([key, label]) => (
              <button
                key={key}
                className={prefs.reader.transStyle === key ? 'active' : undefined}
                onClick={() => update({ reader: { transStyle: key } })}
              >
                {label}
              </button>
            ))}
          </div>
        </PrefRow>
      </div>

      <CGroup>阅读</CGroup>
      <div className="card pref-card">
        <PrefRow name="朗读跟随滚动" desc="整章连读时当前句自动滚到视口中央">
          <Switch
            on={prefs.reader.follow}
            onChange={(v) => update({ reader: { follow: v } })}
          />
        </PrefRow>
        <PrefRow name="右栏英文可点词" desc="学习卡与句子面板里的英文单词可点击查词">
          <Switch
            on={prefs.reader.clickableWords}
            onChange={(v) => update({ reader: { clickableWords: v } })}
          />
        </PrefRow>
        <PrefRow name="单词拆开记" desc="词卡里把单词拆成音节与词根词缀帮助记忆；音节离线即时，词根词缀按需调 AI 并缓存">
          <div className="seg">
            {BREAKDOWN_OPTIONS.map(([key, label]) => (
              <button
                key={key}
                className={prefs.vocab.breakdown === key ? 'active' : undefined}
                onClick={() => update({ vocab: { breakdown: key } })}
              >
                {label}
              </button>
            ))}
          </div>
        </PrefRow>
        <PrefRow name="背单词自动发音" desc="词库学习/复习翻到新卡时自动朗读单词">
          <Switch
            on={prefs.vocab.autoplay}
            onChange={(v) => update({ vocab: { autoplay: v } })}
          />
        </PrefRow>
      </div>

      <CGroup>看板娘</CGroup>
      <div className="card pref-card">
        <PrefRow name="显示看板娘" desc="阅读页右下角的 Live2D 陪读角色">
          <Switch
            on={prefs.mascot.enabled}
            onChange={(v) => update({ mascot: { enabled: v } })}
          />
        </PrefRow>
        <PrefRow name="角色模型" desc="来自 /mascots 清单，切换后阅读页即时生效">
          <Sel
            display={
              manifestQuery.isError
                ? '清单加载失败'
                : (currentModel?.name ?? '默认')
            }
            disabled={models.length === 0}
            groups={[
              {
                items: models.map((m) => ({
                  key: m.id,
                  label: m.name,
                  active: m.id === currentModel?.id,
                  onSelect: () => update({ mascot: { modelId: m.id } }),
                })),
              },
            ]}
          />
        </PrefRow>
      </div>

      {!synced && (
        <div className="st-note">
          服务端偏好尚未同步（后端未就绪或网络异常），当前修改先保存在本地，联通后自动写回
        </div>
      )}
    </>
  )
}
