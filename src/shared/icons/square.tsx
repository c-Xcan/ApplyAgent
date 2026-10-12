import { motion, useAnimation } from 'motion/react'
import type { HTMLAttributes } from 'react'
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'
import { cn } from '../cn'

export interface SquareIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

interface SquareIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number
}

/** 停止按钮用的方块；lucide-animated 无纯 square，按同库模式补一个。 */
const SquareIcon = forwardRef<SquareIconHandle, SquareIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation()
    const isControlledRef = useRef(false)

    useImperativeHandle(ref, () => {
      isControlledRef.current = true
      return {
        startAnimation: () => controls.start('animate'),
        stopAnimation: () => controls.start('normal'),
      }
    })

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) onMouseEnter?.(e)
        else controls.start('animate')
      },
      [controls, onMouseEnter],
    )

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) onMouseLeave?.(e)
        else controls.start('normal')
      },
      [controls, onMouseLeave],
    )

    return (
      <div className={cn(className)} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} {...props}>
        <motion.svg
          animate={controls}
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          transition={{ type: 'spring', stiffness: 250, damping: 18 }}
          variants={{ normal: { scale: 1 }, animate: { scale: 0.85 } }}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
        </motion.svg>
      </div>
    )
  },
)

SquareIcon.displayName = 'SquareIcon'

export { SquareIcon }
