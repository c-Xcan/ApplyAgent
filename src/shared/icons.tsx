// 图标：lucide-animated（https://lucide-animated.com）按需接入，悬停用 Motion 动画。
import { forwardRef, type ForwardRefExoticComponent, type HTMLAttributes, type RefAttributes } from 'react'
import { ArrowUpIcon } from './icons/arrow-up'
import { AttachFileIcon } from './icons/attach-file'
import { BadgeAlertIcon } from './icons/badge-alert'
import { CheckIcon } from './icons/check'
import { ChevronDownIcon } from './icons/chevron-down'
import { CircleCheckIcon } from './icons/circle-check'
import { CopyIcon } from './icons/copy'
import { DeleteIcon } from './icons/delete'
import { DownloadIcon } from './icons/download'
import { FileTextIcon } from './icons/file-text'
import { HardDriveUploadIcon } from './icons/hard-drive-upload'
import { HistoryIcon } from './icons/history'
import { LoaderCircleIcon } from './icons/loader-circle'
import { LogOutIcon } from './icons/log-out'
import { MessageSquareIcon } from './icons/message-square'
import { OctagonXIcon } from './icons/octagon-x'
import { PlayIcon } from './icons/play'
import { PlusIcon } from './icons/plus'
import { SendIcon } from './icons/send'
import { SettingsIcon } from './icons/settings'
import { SparklesIcon } from './icons/sparkles'
import { SquareIcon } from './icons/square'
import { SquarePenIcon } from './icons/square-pen'
import { UploadIcon } from './icons/upload'
import { UserIcon } from './icons/user'
import { WalletIcon } from './icons/wallet'
import { XIcon } from './icons/x'

type IconComp = ForwardRefExoticComponent<
  HTMLAttributes<HTMLDivElement> & { size?: number } & RefAttributes<{ startAnimation: () => void; stopAnimation: () => void }>
>

const ICONS = {
  'arrow-up': ArrowUpIcon,
  check: CheckIcon,
  'chevron-down': ChevronDownIcon,
  'circle-alert': BadgeAlertIcon,
  'circle-check': CircleCheckIcon,
  copy: CopyIcon,
  download: DownloadIcon,
  'file-text': FileTextIcon,
  'file-up': HardDriveUploadIcon,
  history: HistoryIcon,
  'loader-circle': LoaderCircleIcon,
  'log-out': LogOutIcon,
  'message-square-text': MessageSquareIcon,
  'octagon-x': OctagonXIcon,
  paperclip: AttachFileIcon,
  pencil: SquarePenIcon,
  play: PlayIcon,
  plus: PlusIcon,
  send: SendIcon,
  settings: SettingsIcon,
  sparkles: SparklesIcon,
  square: SquareIcon,
  trash: DeleteIcon,
  upload: UploadIcon,
  'user-round': UserIcon,
  wallet: WalletIcon,
  x: XIcon,
} as const satisfies Record<string, IconComp>

export type IconName = keyof typeof ICONS
export type IconHandle = { startAnimation: () => void; stopAnimation: () => void }

export const Icon = forwardRef<IconHandle, { name: IconName; size?: number } & HTMLAttributes<HTMLDivElement>>(
  function Icon({ name, size = 16, className = '', ...rest }, ref) {
    const Comp = ICONS[name] as IconComp
    return <Comp ref={ref} size={size} className={'lucide ' + className} {...rest} />
  },
)
