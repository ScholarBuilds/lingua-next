import { Bookmark } from './NexusIcon'
import type { LucideProps } from './NexusIcon'

export {
  LibraryBig as IconBook, ListTree as IconVocab, AudioLines as IconPhonetics,
  Image as IconImage, Workflow as IconGrammar, Video as IconVideo,
  AudioLines as IconMic, MessageSquareText as IconChat, LayoutGrid as IconStudio,
  Settings2 as IconSettings, Info as IconSun, Info as IconMoon, X as IconEyeOff,
  Search as IconSearch, Plus as IconPlus, Upload as IconUpload, Check as IconCheck,
  ChevronRight as IconChevronRight, ArrowLeft as IconArrowLeft,
  ChevronLeft as IconChevronLeft, X as IconClose, AudioLines as IconSpeaker,
  Play as IconPlay, AudioLines as IconEar, Workflow as IconOrbit, Link as IconPlug,
  PenLine as IconPointer, Square as IconPause, ArrowLeft as IconSkipBack,
  ArrowRight as IconSkipForward, Crop as IconLocate, Wand2 as IconSparkle,
  LayoutGrid as IconSidebar, FileText as IconFileText, Link as IconLink,
  RefreshCw as IconRepeatOne, Square as IconStepPause, PenLine as IconWordClick,
  ArrowRight as IconJump, Send as IconSend, AudioLines as IconVoice,
  ChevronDown as IconChevronDown, Clock as IconClock, ListTree as IconTask,
  ExternalLink as IconArrowUpRight, Focus as IconTarget, Grid3x3 as IconChart,
  Pencil as IconEdit, Trash2 as IconTrash, Download as IconDownload,
  AlertTriangle as IconAlert, Info as IconHelp, FileClock as IconToday,
  KeyRound as IconKey, FileText as IconMail, MoreHorizontal as IconMore,
} from './NexusIcon'

export function IconStar({ filled: _filled, ...props }: LucideProps & { filled?: boolean }) {
  void _filled
  return <Bookmark {...props} />
}
