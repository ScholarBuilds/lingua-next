import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { docsApi } from '@/lib/api-grammar-docs'

export function SoftwareEnglishLegacyRedirect() {
  const location = useLocation()
  const navigate = useNavigate()
  const [message, setMessage] = useState('正在迁移旧的软件英语定位…')

  useEffect(() => {
    const old = new URLSearchParams(location.search)
    const library = old.get('library')
    const document = old.get('document')
    if (library && document) {
      const next = new URLSearchParams({ tab: 'software', software: library, doc: document })
      if (old.get('anchor')) next.set('anchor', old.get('anchor')!)
      navigate(`/grammar?${next}`, { replace: true })
      return
    }
    if (![...old.keys()].some(key => ['collection', 'page', 'capture', 'entry'].includes(key))) {
      navigate('/grammar?tab=software', { replace: true })
      return
    }
    let active = true
    void docsApi.resolveLegacySoftwareSource(old).then(result => {
      if (!active) return
      if (!result.found || !result.library || !result.document) {
        setMessage(result.message ?? '原截图定位已归档')
        return
      }
      const next = new URLSearchParams({ tab: 'software', software: result.library, doc: result.document })
      if (result.anchor) next.set('anchor', result.anchor)
      navigate(`/grammar?${next}`, { replace: true })
    }).catch(() => setMessage('旧定位解析失败，可返回软件库手动选择教程'))
    return () => { active = false }
  }, [location.search, navigate])

  return <main className="page"><div className="software-legacy-message"><h1>软件英语已迁入英语讲义</h1><p>{message}</p><button className="btn btn-primary" onClick={() => navigate('/grammar?tab=software', { replace: true })}>返回软件库</button></div></main>
}
