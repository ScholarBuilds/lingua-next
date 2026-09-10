import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { IconAlert, IconDownload } from '../../components/icons'
import { api, EXPORT_VOCAB_APKG_URL, EXPORT_VOCAB_CSV_URL } from '../../lib/api'
import type { ReviewReport } from '../../lib/api'
import { saveFile } from '@/lib/shell'

/** 复习次数 → 热力档位 0-4（按当年最大值分档） */
function heatLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)))
}

/** "YYYY-MM-DD" → "M/D" */
function shortDate(date: string): string {
  const parts = date.split('-')
  if (parts.length !== 3) return date
  return `${Number(parts[1])}/${Number(parts[2])}`
}

function Heatmap({ data }: { data: ReviewReport['heatmap'] }) {
  const { cells, max } = useMemo(() => {
    const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date))
    const maxCount = sorted.reduce((m, d) => Math.max(m, d.count), 0)
    // 列为周、行为周几：首日前补空槽对齐星期（周日行首）
    const lead = sorted.length > 0 ? new Date(sorted[0].date).getDay() : 0
    const blanks = Number.isNaN(lead) ? 0 : lead
    return {
      cells: [
        ...Array.from({ length: blanks }, () => null),
        ...sorted,
      ] as Array<ReviewReport['heatmap'][number] | null>,
      max: maxCount,
    }
  }, [data])

  return (
    <>
      <div className="hm-scroll">
        <div className="heatmap">
          {cells.map((c, i) =>
            c === null ? (
              <span key={`b${i}`} className="hm-cell blank" />
            ) : (
              <span
                key={c.date}
                className={`hm-cell${c.count > 0 ? ` l${heatLevel(c.count, max)}` : ''}`}
                title={`${c.date} · 复习 ${c.count} 次`}
              />
            ),
          )}
        </div>
      </div>
      <div className="hm-legend">
        <span>少</span>
        <span className="hm-cell" />
        <span className="hm-cell l1" />
        <span className="hm-cell l2" />
        <span className="hm-cell l3" />
        <span className="hm-cell l4" />
        <span>多</span>
      </div>
    </>
  )
}

function DailyBars({ data }: { data: ReviewReport['daily'] }) {
  const days = useMemo(() => [...data].sort((a, b) => a.date.localeCompare(b.date)), [data])
  const max = days.reduce((m, d) => Math.max(m, d.reviewed, d.learned), 0)
  const h = (v: number) => (max > 0 && v > 0 ? Math.max(3, Math.round((v / max) * 100)) : 0)

  return (
    <>
      <div className="bars">
        {days.map((d) => (
          <div
            key={d.date}
            className="bar-day"
            title={`${d.date} · 复习 ${d.reviewed} · 新学 ${d.learned}`}
          >
            <i className="rv" style={{ height: `${h(d.reviewed)}%` }} />
            <i className="ln" style={{ height: `${h(d.learned)}%` }} />
          </div>
        ))}
      </div>
      <div className="bars-axis">
        {days.map((d, i) => (
          <span key={d.date}>{i % 5 === 0 ? shortDate(d.date) : ''}</span>
        ))}
      </div>
      <div className="bars-legend">
        <span>
          <i className="rv" />
          复习
        </span>
        <span>
          <i className="ln" />
          新学
        </span>
      </div>
    </>
  )
}

function SourceBar({ by_source }: { by_source: ReviewReport['by_source'] }) {
  const total = by_source.reading + by_source.wordlist
  if (total === 0) {
    return <div className="panel-hint">还没有生词，去阅读里点词收藏或从词表学新词吧</div>
  }
  const readingPct = Math.round((by_source.reading / total) * 100)
  return (
    <>
      <div className="src-bar">
        <i className="reading" style={{ width: `${readingPct}%` }} />
        <i className="wordlist" style={{ width: `${100 - readingPct}%` }} />
      </div>
      <div className="src-legend">
        <span>
          阅读收藏 <b>{by_source.reading.toLocaleString()}</b>（{readingPct}%）
        </span>
        <span>
          词表学习 <b>{by_source.wordlist.toLocaleString()}</b>（{100 - readingPct}%）
        </span>
      </div>
    </>
  )
}

/** 学习报告：年度热力图 / 近 30 天 / 总览 / 来源与文章 / 导出 */
export function ReportPane() {
  const reportQuery = useQuery({ queryKey: ['review-report'], queryFn: api.reviewReport })

  if (reportQuery.isPending) {
    return (
      <div className="report-pane">
        <div className="state-block">
          <div className="spinner" />
          <div>生成学习报告…</div>
        </div>
      </div>
    )
  }

  if (reportQuery.isError) {
    return (
      <div className="report-pane">
        <div className="state-block">
          <IconAlert />
          <div>报告加载失败：{reportQuery.error.message}</div>
          <button className="btn btn-outline" onClick={() => void reportQuery.refetch()}>
            重试
          </button>
        </div>
      </div>
    )
  }

  const report = reportQuery.data

  return (
    <div className="report-pane">
      <div className="report-inner">
        <div className="rp-title">学习报告</div>

        <section className="rp-sec">
          <div className="rp-sec-head">总览</div>
          <div className="rp-cards">
            <div className="card stat">
              <b>{report.totals.vocab_total.toLocaleString()}</b>
              <span>词汇总量</span>
            </div>
            <div className="card stat ok">
              <b>{report.totals.known.toLocaleString()}</b>
              <span>已掌握</span>
            </div>
            <div className="card stat warn">
              <b>{report.totals.learning.toLocaleString()}</b>
              <span>学习中</span>
            </div>
            <div className="card stat accent">
              <b>{report.totals.reviews_total.toLocaleString()}</b>
              <span>累计复习</span>
            </div>
          </div>
        </section>

        <section className="rp-sec">
          <div className="rp-sec-head">过去一年的复习</div>
          <Heatmap data={report.heatmap} />
        </section>

        <section className="rp-sec">
          <div className="rp-sec-head">近 30 天</div>
          <DailyBars data={report.daily} />
        </section>

        <section className="rp-sec">
          <div className="rp-sec-head">生词来源</div>
          <SourceBar by_source={report.by_source} />
        </section>

        <section className="rp-sec">
          <div className="rp-sec-head">生词最多的文章</div>
          {report.top_articles.length === 0 ? (
            <div className="panel-hint">阅读中还没有收藏过生词</div>
          ) : (
            <div className="top-list">
              {report.top_articles.slice(0, 5).map((a, i) => (
                <div className="top-row" key={`${a.title}-${i}`}>
                  <span className="top-rank">{i + 1}</span>
                  <span className="top-title" title={a.title}>
                    {a.title}
                  </span>
                  <span className="chip warn">{a.vocab_count} 词</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rp-sec">
          <div className="rp-sec-head">导出</div>
          <div className="rp-export">
            <button className="btn btn-outline" onClick={() => saveFile(EXPORT_VOCAB_CSV_URL, 'vocab.csv')}>
              <IconDownload />
              导出 CSV
            </button>
            <button className="btn btn-outline" onClick={() => saveFile(EXPORT_VOCAB_APKG_URL, 'vocab.apkg')}>
              <IconDownload />
              导出 Anki 牌组
            </button>
          </div>
          <div className="field-hint" style={{ marginTop: 8 }}>
            CSV 可导入 Excel / Notion；.apkg 双击即可导入 Anki
          </div>
        </section>
      </div>
    </div>
  )
}
