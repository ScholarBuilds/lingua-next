/* 数据管理：存储统计 / 清理 TTS 缓存（带确认层）/ 数据导出 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'
import { useState } from 'react'

import { IconClose, IconDownload } from '../../components/icons'
import { EXPORT_VOCAB_APKG_URL, EXPORT_VOCAB_CSV_URL } from '../../lib/api'
import { apiConfig } from '../../lib/api-config'
import { setTtsEpoch } from '../../lib/audio'
import { usePrefStore } from '../../lib/prefStore'
import { CGroup, ErrorBlock, LoadingCards, SecHead } from './shared'
import { saveFile } from '@/lib/shell'
import { LectureLibrarySetup } from './LectureLibrarySetup'

function fmtMb(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  return v >= 1024 ? `${(v / 1024).toFixed(2)} GB` : `${v.toFixed(1)} MB`
}

function fmtCount(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '—'
}

function ClearCacheOverlay({
  title,
  description,
  mutationFn,
  onClose,
}: {
  title: string
  description: string
  mutationFn: () => Promise<{ cleared_mb: number; files: number; epoch?: number }>
  onClose: () => void
}) {
  const qc = useQueryClient()
  const clearMut = useMutation({
    mutationFn,
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['cfg-storage'] })
      // 删了服务端文件浏览器还有 7 天缓存：代号变了 URL 才变（FR-499）
      if (typeof data.epoch === 'number') {
        setTtsEpoch(data.epoch)
        void qc.invalidateQueries({ queryKey: ['word-voices'] })
      }
    },
  })

  return (
    <Overlay onClose={onClose}>
        <div className="overlay-head">
          <div className="overlay-title">{title}</div>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        {clearMut.data === undefined ? (
          <>
            <div className="st-note" style={{ marginTop: 0 }}>
              {description}
            </div>
            {clearMut.isError && <div className="form-err">清理失败：{clearMut.error.message}</div>}
            <div className="overlay-foot">
              <button className="btn" onClick={onClose}>
                取消
              </button>
              <button
                className={`btn btn-danger-solid${clearMut.isPending ? ' loading' : ''}`}
                disabled={clearMut.isPending}
                onClick={() => clearMut.mutate()}
              >
                {clearMut.isPending && <span className="spinner" />}
                确认清理
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="chip ok" style={{ alignSelf: 'flex-start' }}>
              已清理 {fmtMb(clearMut.data.cleared_mb)} · {clearMut.data.files} 个文件
            </div>
            <div className="overlay-foot">
              <button className="btn btn-primary" onClick={onClose}>
                完成
              </button>
            </div>
          </>
        )}
    </Overlay>
  )
}

/** 偏好整包导出为 JSON 文件（客户端生成，无需后端） */
function downloadPrefs() {
  const prefs = usePrefStore.getState().prefs
  saveFile(new Blob([JSON.stringify(prefs, null, 2)], { type: 'application/json' }), 'lingua-prefs.json')
}

export function DataSection() {
  const statsQuery = useQuery({
    queryKey: ['cfg-storage'],
    queryFn: apiConfig.storageStats,
  })
  const [clearOpen, setClearOpen] = useState(false)
  const [clearModelsOpen, setClearModelsOpen] = useState(false)
  const stats = statsQuery.data

  return (
    <>
      <SecHead title="数据管理" desc="本地存储占用、缓存清理与学习数据导出。" />

      <CGroup>存储统计</CGroup>
      {statsQuery.isPending && <LoadingCards count={1} height={86} />}
      {statsQuery.isError && (
        <ErrorBlock
          message={`存储统计加载失败：${statsQuery.error.message}`}
          onRetry={() => void statsQuery.refetch()}
        />
      )}
      {stats !== undefined && (
        <div className="stat-grid">
          <div className="card stat">
            <div className="stat-num">{fmtMb(stats.tts_cache_mb)}</div>
            <div className="stat-label">TTS 音频缓存</div>
          </div>
          <div className="card stat">
            <div className="stat-num">{fmtCount(stats.analysis_rows)}</div>
            <div className="stat-label">AI 分析产物（条）</div>
          </div>
          <div className="card stat">
            <div className="stat-num">{fmtMb(stats.media_mb)}</div>
            <div className="stat-label">媒体文件</div>
          </div>
          <div className="card stat">
            <div className="stat-num">{fmtMb(stats.local_models_mb)}</div>
            <div className="stat-label">可选本地模型</div>
          </div>
        </div>
      )}

      <CGroup>讲义库</CGroup>
      <LectureLibrarySetup />

      <CGroup>缓存清理</CGroup>
      <div className="card pref-card">
        <div className="pref-row">
          <div className="pref-info">
            <div className="pref-name">清理 TTS 音频缓存</div>
            <div className="pref-desc">
              删除已合成的朗读音频，再次朗读时按需重新合成；AI 分析产物按内容指纹持久化，不在清理范围
            </div>
          </div>
          <button className="btn btn-danger" onClick={() => setClearOpen(true)}>
            清理缓存
          </button>
        </div>
        <div className="pref-row">
          <div className="pref-info">
            <div className="pref-name">卸载可选本地模型</div>
            <div className="pref-desc">
              删除已下载的 ASR/TTS 大模型，释放空间；下次启用相应能力时重新下载
            </div>
          </div>
          <button className="btn btn-danger" onClick={() => setClearModelsOpen(true)}>
            卸载模型
          </button>
        </div>
      </div>

      <CGroup>数据导出</CGroup>
      <div className="card pref-card">
        <div className="pref-row">
          <div className="pref-info">
            <div className="pref-name">生词表 CSV</div>
            <div className="pref-desc">全部生词与释义、语境例句，可导入表格软件</div>
          </div>
          <a className="btn btn-outline" href={EXPORT_VOCAB_CSV_URL} download>
            <IconDownload />
            导出 CSV
          </a>
        </div>
        <div className="pref-row">
          <div className="pref-info">
            <div className="pref-name">Anki 牌组</div>
            <div className="pref-desc">.apkg 格式，导入 Anki 后继续离线复习</div>
          </div>
          <a className="btn btn-outline" href={EXPORT_VOCAB_APKG_URL} download>
            <IconDownload />
            导出 .apkg
          </a>
        </div>
        <div className="pref-row">
          <div className="pref-info">
            <div className="pref-name">偏好配置 JSON</div>
            <div className="pref-desc">主题、朗读、看板娘等偏好整包备份（本机生成）</div>
          </div>
          <button className="btn btn-outline" onClick={downloadPrefs}>
            <IconDownload />
            导出 JSON
          </button>
        </div>
      </div>

      {clearOpen && (
        <ClearCacheOverlay
          title="清理 TTS 音频缓存"
          description={`将删除全部已合成的朗读音频文件（当前约 ${fmtMb(stats?.tts_cache_mb)}）。词句再次朗读时会重新合成，首次播放会稍慢并可能产生合成费用；不影响词库、批注等学习数据。`}
          mutationFn={apiConfig.clearTtsCache}
          onClose={() => setClearOpen(false)}
        />
      )}
      {clearModelsOpen && (
        <ClearCacheOverlay
          title="卸载可选本地模型"
          description={`将删除已下载的 ASR/TTS 大模型（当前约 ${fmtMb(stats?.local_models_mb)}）。下次启用相应能力时需重新下载；不影响随包的唤醒词模型、用户数据和凭据。`}
          mutationFn={apiConfig.clearLocalModels}
          onClose={() => setClearModelsOpen(false)}
        />
      )}
    </>
  )
}
