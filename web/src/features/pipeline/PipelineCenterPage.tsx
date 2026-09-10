/* /pipeline 深链保留（CR-006 D4）：管线中心已并进任务中心，成为那一页的「管线总览」视图。
   域页 /pipeline/:domain 与主体下钻页不受影响。 */

import { Navigate } from 'react-router-dom'

export function PipelineCenterPage() {
  return <Navigate to="/tasks?view=pipelines" replace />
}
