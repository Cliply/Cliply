"use client"

import { motion } from "framer-motion"
import { ArrowRight } from "lucide-react"
import { Link } from "react-router-dom"

type MenuItem = {
  label: string
  href?: string
  external?: boolean
  onClick?: () => void
}

interface MenuVerticalProps {
  menuItems: MenuItem[]
  color?: string
  skew?: number
}

export const MenuVertical = ({
  menuItems = [],
  color = "#0891b2",
  skew = 0
}: MenuVerticalProps) => {
  return (
    <div className="flex w-fit flex-col gap-2 px-4">
      {menuItems.map((item, index) => (
        <motion.div
          key={`${item.href || item.label}-${index}`}
          className="group/nav flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300"
          initial="initial"
          whileHover="hover"
          onClick={item.onClick}
        >
          <motion.div
            variants={{
              initial: { x: "-100%", color: "inherit", opacity: 0 },
              hover: { x: 0, color, opacity: 1 }
            }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="z-0"
          >
            <ArrowRight strokeWidth={2} className="size-4" />
          </motion.div>

          {item.external && item.href ? (
            <motion.a
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              variants={{
                initial: { x: -20, color: "inherit" },
                hover: { x: 0, color, skewX: skew }
              }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="font-medium text-sm no-underline"
              style={{
                fontFamily:
                  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
              }}
            >
              {item.label}
            </motion.a>
          ) : item.href ? (
            <Link to={item.href}>
              <motion.span
                variants={{
                  initial: { x: -20, color: "inherit" },
                  hover: { x: 0, color, skewX: skew }
                }}
                transition={{ duration: 0.3, ease: "easeOut" }}
                className="font-medium text-sm no-underline"
                style={{
                  fontFamily:
                    'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
                }}
              >
                {item.label}
              </motion.span>
            </Link>
          ) : (
            <motion.span
              variants={{
                initial: { x: -20, color: "inherit" },
                hover: { x: 0, color, skewX: skew }
              }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="font-medium text-sm no-underline"
              style={{
                fontFamily:
                  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
              }}
            >
              {item.label}
            </motion.span>
          )}
        </motion.div>
      ))}
    </div>
  )
}
