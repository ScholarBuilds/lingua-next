/* 用量统计：近 30 天按功能、按路由的调用量与延迟（/api/usage/summary） */

import { useQuery } from '@tanstack/react-query'

import { IconAlert } from '../../components/icons'
import { apiM5 } from '../../lib/api-m5'
import { fmtMs, fmtUsd } from './meta'
import { CGroup, SecHead } from './shared'

/** 用量表 kind → 中文名 */
const KIND_LABELS: Record<string, string> = {
  translate: '整句翻译',
  word_explain: '词汇讲解',
  phrase: '短语解释',
  grammar: '语法分析',
  sentence_deep: '长难句精讲',
  summary: '全文概要',
  companion: '语音陪读',
}

export function UsageSection() {
  const summaryQuery = useQuery({
    queryKey: ['usage-summary'],
    queryFn: () => apiM5.usageSummary(30),
  })

  const summary = summaryQuery.data

  return (
    <>
      <SecHead title="用量统计" desc="近 30 天的 AI 调用量与延迟，来自本地调用台账。" />

      {summaryQuery.isPending && <div className="skeleton" style={{ height: 120 }} />}

      {summaryQuery.isError && (
        <div className="state-block">
          <IconAlert />
          <div>用量数据加载失败：{summaryQuery.error.message}</div>
          <button className="btn btn-outline" onClick={() => void summaryQuery.refetch()}>
            重试
          </button>
        </div>
      )}

      {summary !== undefined && (
        <>
          <CGroup>按功能统计 · 近 30 天</CGroup>
          {summary.analysis.by_kind.length === 0 ? (
            <div className="st-note">近 30 天暂无生成记录</div>
          ) : (
            <div className="usage-table-wrap">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>功能</th>
                    <th>提供方</th>
                    <th className="num">次数</th>
                    <th className="num">P50 延迟</th>
                    <th className="num">P95 延迟</th>
                    <th className="num">费用</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.analysis.by_kind.map((row) => (
                    <tr key={`${row.kind}-${row.provider}`}>
                      <td>{KIND_LABELS[row.kind] ?? row.kind}</td>
                      <td className="sub">{row.provider}</td>
                      <td className="num">{row.count.toLocaleString()}</td>
                      <td className="num">{fmtMs(row.latency_p50_ms)}</td>
                      <td className="num">{fmtMs(row.latency_p95_ms)}</td>
                      <td className="num">
                        {row.cost_micros === null ? '—' : fmtUsd(row.cost_micros / 1e6)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {summary.analysis.notice != null && (
            <div className="st-note">{summary.analysis.notice}</div>
          )}

          <CGroup>按能力与模型统计 · 近 30 天</CGroup>
          {summary.invocations.by_route.length === 0 ? (
            <div className="st-note">近 30 天暂无模型调用记录</div>
          ) : (
            <div className="usage-table-wrap">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>能力</th>
                    <th>模型</th>
                    <th className="num">调用</th>
                    <th className="num">失败</th>
                    <th className="num">Tokens</th>
                    <th className="num">P95 延迟</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.invocations.by_route.map((row) => (
                    <tr key={`${row.capability}-${row.plugin_id}-${row.model}`}>
                      <td>{row.capability ?? '—'}</td>
                      <td className="model">
                        {row.model ?? '—'}
                        <span className="sub"> · {row.plugin_id}</span>
                      </td>
                      <td className="num">{row.count.toLocaleString()}</td>
                      <td className="num">{row.failed.toLocaleString()}</td>
                      <td className="num">
                        {(row.input_tokens + row.output_tokens).toLocaleString()}
                      </td>
                      <td className="num">{fmtMs(row.latency_p95_ms)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>合计</td>
                    <td className="sub">—</td>
                    <td className="num">{summary.invocations.total.count.toLocaleString()}</td>
                    <td className="num">{summary.invocations.total.failed.toLocaleString()}</td>
                    <td className="num">
                      {(
                        summary.invocations.total.input_tokens +
                        summary.invocations.total.output_tokens
                      ).toLocaleString()}
                    </td>
                    <td className="num">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {summary.invocations.notice != null && (
            <div className="st-note">{summary.invocations.notice}</div>
          )}
        </>
      )}
    </>
  )
}
