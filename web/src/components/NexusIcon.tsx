import { forwardRef } from 'react'
import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from 'react'

type Glyph =
  | 'back' | 'forward' | 'up' | 'down' | 'close' | 'check'
  | 'plus' | 'minus' | 'search' | 'more' | 'refresh' | 'play'
  | 'pause' | 'download' | 'upload' | 'copy' | 'edit' | 'delete'
  | 'save' | 'folder' | 'document' | 'image' | 'video' | 'audio'
  | 'link' | 'settings' | 'info' | 'warning' | 'lock' | 'key'
  | 'grid' | 'list' | 'crop' | 'wand' | 'cloud' | 'workflow'

export interface LucideProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  absoluteStrokeWidth?: boolean
  size?: number | string
  strokeWidth?: number | string
}

export type LucideIcon = ForwardRefExoticComponent<LucideProps & RefAttributes<SVGSVGElement>>

const GLYPHS: Record<Glyph, readonly [number, number]> = {
  back: [0, 0], forward: [1, 0], up: [2, 0], down: [3, 0], close: [4, 0], check: [5, 0],
  plus: [0, 1], minus: [1, 1], search: [2, 1], more: [3, 1], refresh: [4, 1], play: [5, 1],
  pause: [0, 2], download: [1, 2], upload: [2, 2], copy: [3, 2], edit: [4, 2], delete: [5, 2],
  save: [0, 3], folder: [1, 3], document: [2, 3], image: [3, 3], video: [4, 3], audio: [5, 3],
  link: [0, 4], settings: [1, 4], info: [2, 4], warning: [3, 4], lock: [4, 4], key: [5, 4],
  grid: [0, 5], list: [1, 5], crop: [2, 5], wand: [3, 5], cloud: [4, 5], workflow: [5, 5],
}

function glyph(name: Glyph): LucideIcon {
  const [column, row] = GLYPHS[name]
  const Component = forwardRef<SVGSVGElement, LucideProps>(function NexusIcon(
    { size = 24, className, absoluteStrokeWidth: _absoluteStrokeWidth, strokeWidth: _strokeWidth, ...props },
    ref,
  ) {
    void _absoluteStrokeWidth
    void _strokeWidth
    return (
      <svg
        {...props}
        ref={ref}
        className={`nexus-icon${className ? ` ${className}` : ''}`}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        data-glyph={name}
        aria-hidden={props['aria-label'] === undefined ? true : undefined}
      >
        <image
          className="nexus-icon-atlas"
          href="/brand/image2/action-atlas.webp"
          width="144"
          height="144"
          x={-column * 24}
          y={-row * 24}
          preserveAspectRatio="none"
        />
      </svg>
    )
  })
  Component.displayName = `NexusIcon(${name})`
  return Component
}

export const Activity = glyph('workflow')
export const AlertTriangle = glyph('warning')
export const AppWindow = glyph('grid')
export const Archive = glyph('folder')
export const ArchiveRestore = glyph('refresh')
export const ArrowDown = glyph('down')
export const ArrowLeft = glyph('back')
export const ArrowLeftIcon = ArrowLeft
export const ArrowLeftRight = glyph('refresh')
export const ArrowRight = glyph('forward')
export const ArrowUp = glyph('up')
export const AudioLines = glyph('audio')
export const Ban = glyph('close')
export const Bookmark = glyph('document')
export const Boxes = glyph('grid')
export const Braces = glyph('document')
export const Brush = glyph('wand')
export const Camera = glyph('image')
export const Check = glyph('check')
export const CheckIcon = Check
export const ChevronDown = glyph('down')
export const ChevronDownIcon = ChevronDown
export const ChevronLeft = glyph('back')
export const ChevronRight = glyph('forward')
export const ChevronRightIcon = ChevronRight
export const ChevronUpIcon = glyph('up')
export const CircleCheckIcon = Check
export const CircleIcon = glyph('more')
export const Clapperboard = glyph('video')
export const Clipboard = glyph('document')
export const Clock = glyph('refresh')
export const Cloud = glyph('cloud')
export const CloudCog = glyph('cloud')
export const CloudDownload = glyph('download')
export const CloudLightning = glyph('cloud')
export const Combine = glyph('workflow')
export const Compass = glyph('workflow')
export const Copy = glyph('copy')
export const CopyIcon = Copy
export const CopyPlus = glyph('copy')
export const CornerDownLeft = glyph('back')
export const Crop = glyph('crop')
export const DatabaseZap = glyph('save')
export const Download = glyph('download')
export const Eraser = glyph('delete')
export const ExternalLink = glyph('link')
export const Eye = glyph('info')
export const FileClock = glyph('document')
export const FileImage = glyph('image')
export const FileJson2 = glyph('document')
export const FileOutput = glyph('document')
export const FileText = glyph('document')
export const FileWarning = glyph('warning')
export const Files = glyph('copy')
export const Film = glyph('video')
export const FlaskConical = glyph('wand')
export const Focus = glyph('crop')
export const Folder = glyph('folder')
export const FolderCog = glyph('settings')
export const FolderOpen = glyph('folder')
export const Frame = glyph('crop')
export const GalleryHorizontalEnd = glyph('image')
export const Gamepad2 = glyph('grid')
export const Gauge = glyph('settings')
export const GitBranch = glyph('workflow')
export const Globe = glyph('cloud')
export const GraduationCap = glyph('document')
export const Grid3x3 = glyph('grid')
export const Hammer = glyph('settings')
export const HardDrive = glyph('save')
export const History = glyph('refresh')
export const Image = glyph('image')
export const ImageOff = glyph('close')
export const ImagePlus = glyph('image')
export const Images = glyph('image')
export const Info = glyph('info')
export const InfoIcon = Info
export const KeyRound = glyph('key')
export const Languages = glyph('document')
export const Layers = glyph('copy')
export const Layers3 = glyph('copy')
export const LayoutDashboard = glyph('grid')
export const LayoutGrid = glyph('grid')
export const LibraryBig = glyph('folder')
export const Lightbulb = glyph('info')
export const Link = glyph('link')
export const Link2Off = glyph('link')
export const ListTree = glyph('workflow')
export const Loader2 = glyph('refresh')
export const Loader2Icon = Loader2
export const LoaderCircle = Loader2
export const Lock = glyph('lock')
export const Maximize2 = glyph('grid')
export const MessageCircleQuestion = glyph('info')
export const MessageSquare = glyph('document')
export const MessageSquareText = glyph('document')
export const MessagesSquare = glyph('document')
export const Minimize2 = glyph('minus')
export const Minus = glyph('minus')
export const Monitor = glyph('grid')
export const MoreHorizontal = glyph('more')
export const Music = glyph('audio')
export const OctagonXIcon = glyph('close')
export const PackageOpen = glyph('folder')
export const Palette = glyph('image')
export const PanelsTopLeft = glyph('grid')
export const Paperclip = glyph('link')
export const PenLine = glyph('edit')
export const Pencil = glyph('edit')
export const Play = glyph('play')
export const Plus = glyph('plus')
export const Power = glyph('warning')
export const Radio = glyph('audio')
export const Receipt = glyph('document')
export const Redo2 = glyph('refresh')
export const RefreshCw = glyph('refresh')
export const Repeat2 = glyph('refresh')
export const Replace = glyph('refresh')
export const Rocket = glyph('play')
export const RotateCcw = glyph('refresh')
export const RotateCw = glyph('refresh')
export const Rows3 = glyph('list')
export const Ruler = glyph('settings')
export const Save = glyph('save')
export const ScanLine = glyph('crop')
export const ScanSearch = glyph('search')
export const ScanText = glyph('document')
export const Scissors = glyph('crop')
export const ScrollText = glyph('document')
export const Search = glyph('search')
export const SearchIcon = Search
export const Send = glyph('forward')
export const Settings2 = glyph('settings')
export const Shapes = glyph('grid')
export const ShieldCheck = glyph('lock')
export const ShoppingBag = glyph('folder')
export const Shrink = glyph('minus')
export const Sigma = glyph('document')
export const SlidersHorizontal = glyph('settings')
export const Sparkles = glyph('wand')
export const Square = glyph('pause')
export const TextCursorInput = glyph('edit')
export const Trash2 = glyph('delete')
export const TriangleAlert = glyph('warning')
export const TriangleAlertIcon = TriangleAlert
export const Undo2 = glyph('refresh')
export const Ungroup = glyph('grid')
export const Upload = glyph('upload')
export const UserRound = glyph('info')
export const Video = glyph('video')
export const WalletCards = glyph('key')
export const Wand2 = glyph('wand')
export const WandSparkles = glyph('wand')
export const Waypoints = glyph('workflow')
export const Workflow = glyph('workflow')
export const Wrench = glyph('settings')
export const X = glyph('close')
export const XCircle = glyph('close')
export const XIcon = X
export const Zap = glyph('wand')
export const ZoomIn = glyph('plus')
export const ZoomOut = glyph('minus')
