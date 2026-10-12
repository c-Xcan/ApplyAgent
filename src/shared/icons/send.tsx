import { motion, useAnimation } from 'motion/react'
import type { HTMLAttributes } from 'react'
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'
import { cn } from '../cn'

export interface SendIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

interface SendIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number
}

/** 投递记录用的纸飞机（lucide send），按同库模式补一个：悬停时向右上飞一下 */
const SendIcon = forwardRef<SendIconHandle, SendIconProps>(
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
          variants={{
            normal: { x: 0, y: 0 },
            animate: { x: [0, 2, 0], y: [0, -2, 0], transition: { duration: 0.45, ease: 'easeInOut' } },
          }}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
          <path d="m21.854 2.147-10.94 10.939" />
        </motion.svg>
      </div>
    )
  },
)

SendIcon.displayName = 'SendIcon'

export { SendIcon }
