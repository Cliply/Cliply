import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { motion } from "framer-motion"
import { Check, ChevronDown } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { useState, type ReactNode } from "react"

interface SelectionDropdownProps<T> {
  icon: LucideIcon
  heading: string
  placeholder: string
  options: T[]
  selected: T | null
  onSelect: (option: T) => void
  optionKey: (option: T) => string
  renderLabel: (option: T) => ReactNode
  // the right-hand half of a row: a size, a bitrate, an "Original" marker.
  // returning nothing leaves the row with a label and a checkmark
  renderDetail?: (option: T) => ReactNode
  // shown instead of the control when there is nothing to choose between
  emptyState?: ReactNode
  // the "Selected: ..." line some menus print under the control
  footer?: ReactNode
  onOpenChange?: (isOpen: boolean) => void
  className?: string
}

// a menu with nothing to say about an option leaves the slot empty rather than
// rendering a blank line where the detail would be
function Detail({ children }: { children?: ReactNode }) {
  if (!children) return null

  return (
    <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>
  )
}

/**
 * the dropdown every format menu is built from: heading, trigger, animated
 * panel, rows, selection marker
 *
 * it owns presentation and open/close and nothing else - which option a menu
 * defaults to, and when that default is re-applied, is feature behaviour and
 * stays in the wrapper that knows the domain.
 */
export function SelectionDropdown<T>({
  icon: Icon,
  heading,
  placeholder,
  options,
  selected,
  onSelect,
  optionKey,
  renderLabel,
  renderDetail,
  emptyState,
  footer,
  onOpenChange,
  className
}: SelectionDropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false)

  const toggleOpen = (next: boolean) => {
    setIsOpen(next)
    onOpenChange?.(next)
  }

  const handleSelect = (option: T) => {
    onSelect(option)
    toggleOpen(false)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, height: 0 }}
      animate={{ opacity: 1, y: 0, height: "auto" }}
      exit={{ opacity: 0, y: -20, height: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={cn("space-y-4", "font-space-grotesk", className)}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 text-slate-600 dark:text-slate-400" />
        <h3 className="font-medium text-slate-900 dark:text-white">{heading}</h3>
      </div>

      {emptyState && options.length === 0 ? (
        emptyState
      ) : (
        <div className="relative">
          <Button
            variant="outline"
            onClick={() => toggleOpen(!isOpen)}
            className={cn(
              "w-full justify-between h-auto p-4 text-left",
              "border-2 rounded-xl transition-all duration-200",
              "dark:bg-slate-800/60 dark:border-slate-700/50 dark:hover:border-slate-600",
              "bg-white/80 border-slate-300/50 hover:border-slate-400",
              "backdrop-blur-sm shadow-lg",
              isOpen && "border-slate-400 dark:border-slate-600"
            )}
          >
            <div className="flex-1">
              {selected ? (
                <div className="flex items-center justify-between">
                  <p className="font-medium text-slate-900 dark:text-white">
                    {renderLabel(selected)}
                  </p>
                  <Detail>{renderDetail?.(selected)}</Detail>
                </div>
              ) : (
                <p className="text-slate-500 dark:text-slate-400">
                  {placeholder}
                </p>
              )}
            </div>
            <ChevronDown
              className={cn(
                "h-5 w-5 text-slate-500 transition-transform duration-200",
                isOpen && "rotate-180"
              )}
            />
          </Button>

          {isOpen && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className={cn(
                "absolute top-full left-0 right-0 mt-2 z-[70]",
                "border-2 rounded-xl overflow-hidden",
                "dark:bg-slate-800/95 dark:border-slate-700/50 dark:backdrop-blur-xl",
                "bg-white/95 border-slate-300/50 backdrop-blur-xl",
                "shadow-2xl max-h-80"
              )}
            >
              <div className="max-h-80 overflow-y-auto overscroll-contain">
                {options.map((option) => {
                  const isSelected = selected !== null && option === selected

                  return (
                    <button
                      key={optionKey(option)}
                      onClick={() => handleSelect(option)}
                      className={cn(
                        "w-full p-4 text-left transition-all duration-200",
                        "hover:bg-slate-100/80 dark:hover:bg-slate-700/50",
                        "border-b border-slate-200/50 dark:border-slate-700/50 last:border-b-0",
                        isSelected &&
                          "bg-blue-50 dark:bg-blue-950/20 border-blue-500/20"
                      )}
                    >
                      <div className="flex justify-between items-center">
                        <p className="font-medium text-slate-900 dark:text-white">
                          {renderLabel(option)}
                        </p>
                        <div className="flex items-center gap-3">
                          <Detail>{renderDetail?.(option)}</Detail>
                          {isSelected && (
                            <Check className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </motion.div>
          )}
        </div>
      )}

      {footer}
    </motion.div>
  )
}
