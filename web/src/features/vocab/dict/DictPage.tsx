import { Topbar } from '../../../components/Topbar'
import { WordModal } from '../../reader/WordModal'
import { DictPane } from './DictPane'

export function DictPage() {
  return <div className="main">
    <Topbar title="查词" />
    <DictPane />
    <WordModal />
  </div>
}
