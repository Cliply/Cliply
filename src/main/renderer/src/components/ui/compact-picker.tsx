import { ChevronUp } from "lucide-react"
import { useEffect, useId, useState } from "react"
import type { KeyboardEvent } from "react"
import { MONO } from "@/lib/fonts"
import { cn } from "@/lib/utils"

interface Choice<T extends string> {
  value: T
  label: string
  logo?: string
}

interface Props<T extends string> {
  id?: string
  label: string
  value: T
  options: readonly Choice<T>[]
  onSelect: (value: T) => void
  disabled?: boolean
  title?: string
  className?: string
}

export function CompactPicker<T extends string>({
  id,
  label,
  value,
  options,
  onSelect,
  disabled,
  title,
  className
}: Props<T>) {
  const listId = useId()
  const [active, setActive] = useState<number | null>(null)
  const open = !disabled && active !== null
  const selected = options.find((option) => option.value === value)
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  )
  const activeId = open ? listId + "-" + active : undefined

  useEffect(() => {
    if (disabled) setActive(null)
  }, [disabled])
  useEffect(() => {
    if (activeId)
      document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" })
  }, [activeId])

  function choose(option: Choice<T>) {
    if (disabled) return
    setActive(null)
    onSelect(option.value)
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    if (
      disabled ||
      !options.length ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    )
      return
    switch (event.key) {
      case "ArrowDown":
        setActive(
          open ? Math.min(active + 1, options.length - 1) : selectedIndex
        )
        break
      case "ArrowUp":
        setActive(open ? Math.max(active - 1, 0) : selectedIndex)
        break
      case "Home":
        setActive(0)
        break
      case "End":
        setActive(options.length - 1)
        break
      case "Escape":
        if (!open) return
        setActive(null)
        break
      case "Enter":
      case " ":
        if (open && options[active]) choose(options[active])
        else setActive(selectedIndex)
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  function logo(option?: Choice<T>) {
    return (
      option?.logo && (
        <img
          src={option.logo}
          alt=""
          className="size-3.5 shrink-0 object-contain"
        />
      )
    )
  }

  return (
    <div
      className={cn(
        "min-w-0 select-none overflow-hidden border border-slate-200/50 bg-white dark:border-slate-700/40 dark:bg-slate-800",
        open ? "rounded-2xl" : "rounded-xl",
        disabled && "opacity-50",
        className
      )}
      style={{ fontFamily: MONO }}
    >
      <button
        id={id}
        type="button"
        role="combobox"
        value={value}
        title={title}
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-activedescendant={activeId}
        disabled={disabled}
        onClick={() => setActive(open ? null : selectedIndex)}
        onBlur={() => setActive(null)}
        onKeyDown={navigate}
        className="flex w-full items-center justify-between gap-2 rounded-[inherit] px-2.5 py-1.5 text-left text-xs text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:text-slate-300"
      >
        {logo(selected)}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            open && selected?.logo && "sr-only"
          )}
        >
          {selected?.label ?? value}
        </span>
        <ChevronUp
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 transition-transform motion-reduce:transition-none",
            !open && "rotate-180"
          )}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
        inert={!open}
      >
        <div className="overflow-hidden">
          <div
            id={listId}
            role="listbox"
            aria-label={open ? label : undefined}
            aria-hidden={!open}
            className="max-h-52 space-y-0.5 overflow-y-auto overscroll-contain px-1.5 pb-1.5"
          >
            {open &&
              options.map((option, index) => (
                <div
                  key={option.value}
                  id={listId + "-" + index}
                  role="option"
                  aria-selected={value === option.value}
                  data-value={option.value}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-700/50",
                    option.value === value &&
                      "bg-slate-100 text-slate-900 dark:bg-slate-700/80 dark:text-white",
                    active === index && "ring-1 ring-inset ring-ring"
                  )}
                >
                  {logo(option)}
                  <span className="min-w-0 break-words">{option.label}</span>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}
