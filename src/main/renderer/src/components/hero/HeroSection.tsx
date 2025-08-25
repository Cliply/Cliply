import { ModeToggle } from "@/components/ui/mode-toggle"
import { motion } from "framer-motion"
import { Link } from "react-router-dom"
import { SearchCard } from "./SearchCard"

export function HeroSection() {
  return (
    <section className="relative min-h-screen w-full overflow-hidden">
      {/* Mode toggle - top right */}
      <div className="absolute top-6 right-6 z-20">
        <ModeToggle />
      </div>

      {/* Dark gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 dark:opacity-100 opacity-0 transition-opacity duration-300" />

      {/* Light gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-50 via-slate-100 to-slate-200 dark:opacity-0 opacity-100 transition-opacity duration-300" />

      {/* Subtle noise texture overlay */}
      <div className="absolute inset-0 opacity-10 dark:opacity-20 transition-opacity duration-300">
        <div className="h-full w-full bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8ZGVmcz4KICAgIDxwYXR0ZXJuIGlkPSJub2lzZSIgd2lkdGg9IjQiIGhlaWdodD0iNCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CiAgICAgIDxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiNmZmZmZmYiIG9wYWNpdHk9IjAuMSIvPgogICAgPC9wYXR0ZXJuPgogIDwvZGVmcz4KICA8cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI25vaXNlKSIvPgo8L3N2Zz4K')] opacity-50" />
      </div>

      {/* Main content - Search centered, text above */}
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-4xl mx-auto -mt-16">
          {/* Brand name - positioned above the centered search */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
            className="mb-12 text-center"
          >
            <h1
              className="text-5xl sm:text-6xl md:text-7xl font-light text-slate-900 dark:text-white tracking-tight"
              style={{
                fontFamily:
                  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
              }}
            >
              cliply
            </h1>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.4 }}
              className="mt-4 text-lg sm:text-xl text-slate-600 dark:text-slate-400 font-mono max-w-lg mx-auto"
              style={{
                fontFamily:
                  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
              }}
            >
              download stuff effortlessly{" "}
              <span className="text-cyan-500">(&gt;ᴗ•)</span>
            </motion.p>
          </motion.div>

          {/* Search card - this will be centered in viewport */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.5, ease: "easeOut" }}
          >
            <SearchCard />
          </motion.div>
        </div>
      </div>

      {/* Bottom disclaimer and links */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 1.0 }}
        className="absolute bottom-8 left-0 right-0 z-20"
      >
        <div className="flex justify-center items-center px-4 gap-6">
          <Link
            to="/disclaimer"
            className="text-xs text-slate-500 dark:text-slate-400 hover:text-cyan-500 dark:hover:text-cyan-400 transition-colors duration-200"
            style={{
              fontFamily:
                'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
            }}
          >
            disclaimer
          </Link>
          
          <span className="text-slate-400 dark:text-slate-600">•</span>
          
          <a
            href="https://buymeacoffee.com/itssdevk"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-500 dark:text-slate-400 hover:text-cyan-500 dark:hover:text-cyan-400 transition-colors duration-200"
            style={{
              fontFamily:
                'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
            }}
          >
            donate
          </a>
          
          <span className="text-slate-400 dark:text-slate-600">•</span>
          
          <a
            href="https://github.com/Cliply/Cliply/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-500 dark:text-slate-400 hover:text-cyan-500 dark:hover:text-cyan-400 transition-colors duration-200"
            style={{
              fontFamily:
                'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
            }}
          >
            github
          </a>
        </div>
      </motion.div>

      {/* Subtle bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-slate-200 dark:from-slate-900 to-transparent" />
    </section>
  )
}
