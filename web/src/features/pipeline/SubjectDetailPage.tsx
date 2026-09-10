/* L3 主体详情整页（需求 12 FR-239）：非视频域的管线详情。

   视频域走功能更全的 /video/{id}/pipeline（含问题清单与 AI 修复工作台），
   其余域走这里。两者都是整页——统一形态，不再有的整页有的内嵌抽屉。 */

import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'

import { Topbar } from '../../components/Topbar'
import { apiDeck, apiScenario } from '../../lib/api-deck'
import { apiImage } from '../../lib/api-image'
import { apiPipeline } from '../../lib/api-pipeline'
import { WordModal } from '../reader/WordModal'
import { SubjectPipelinePane } from './SubjectPipelinePane'
import './pipeline.css'

export function SubjectDetailPage() {
  const { domain = '', subjectId = '' } = useParams()
  const navigate = useNavigate()
  const id = Number(subjectId)

  const domains = useQuery({ queryKey: ['pipeline-domains'], queryFn: apiPipeline.domains })
  const spec = domains.data?.find((d) => d.domain === domain)

  const rerun = (
    step: string,
    scope: 'single' | 'downstream' | 'failed',
    config?: Record<string, Record<string, unknown>>,
  ) => {
    if (domain === 'scenario_deck') {
      return apiScenario.rerun(id, step, scope === 'failed' ? 'downstream' : scope, config)
    }
    if (domain === 'image_gen') {
      return apiImage.rerun(id, {
        from_step: step,
        scope: scope === 'failed' ? 'downstream' : scope,
        config,
      })
    }
    return apiPipeline.rerun({ video_id: id, from_step: step, scope, config })
  }

  return (
    <div className="main">
      <Topbar
        back={{ to: `/pipeline/${domain}`, label: '域视图' }}
        crumbs={[
          { label: '管线中心', to: '/pipeline' },
          { label: spec?.label ?? domain, to: `/pipeline/${domain}` },
        ]}
        title={`#${id}`}
        actions={
          domain === 'scenario_deck' ? (
            <button
              className="btn btn-soft"
              onClick={() => void apiDeck.list().then(() => navigate('/vocab'))}
            >
              去词库看这个本
            </button>
          ) : undefined
        }
      />
      <div className="sd-page">
        <SubjectPipelinePane domain={domain} subjectId={id} onRerun={rerun} />
      </div>
      <WordModal />
    </div>
  )
}
