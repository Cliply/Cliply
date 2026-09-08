import { MenuVertical } from "@/components/ui/menu-vertical"
import { ModeToggle } from "@/components/ui/mode-toggle"
import { updaterApi } from "@/lib/api"
import { cookieActions } from "@/lib/cookieStore"
import { motion } from "framer-motion"
import { toast } from "sonner"
import { useAppStore } from "@/lib/store"
import { SearchCard } from "./SearchCard"

export function HeroSection() {
  const { selectedPlatform } = useAppStore()
  const handleCheckForUpdates = async () => {
    try {
      await updaterApi.checkForUpdates()
    } catch (error) {
      console.error("Failed to check for updates:", error)
      toast.error("Check Failed", {
        description:
          error instanceof Error ? error.message : "Failed to check for updates"
      })
    }
  }

  return (
    <section className="relative min-h-screen w-full overflow-hidden">
      {/* Menu - top left for wider phones, tablets, desktop */}
      <div className="absolute top-6 left-2 z-20 hidden sm:block">
        <MenuVertical
          menuItems={[
            // about and github used to sit in a row along the bottom edge.
            // Four items in one column is a menu; two up here and two down
            // there was the same navigation split across opposite corners.
            //
            // about leads because it answers what this thing is, which is the
            // one question a first-time user actually has - and the page it
            // opens has titled itself "about" the whole time. The menu was the
            // only place still calling it the disclaimer.
            {
              label: "about",
              href: "/disclaimer"
            },
            {
              label: "update",
              onClick: handleCheckForUpdates
            },
            // cookies came out of here once the line in the top chrome started
            // offering the same dialog. That one reaches people while they are
            // wondering why downloads keep failing; this one only ever found
            // the users who already went looking, and two doors to the same
            // room made the menu longer for nothing
            {
              label: "donate",
              href: "https://buymeacoffee.com/itssdevk",
              external: true
            },
            {
              label: "github",
              href: "https://github.com/Cliply/Cliply/",
              external: true
            }
          ]}
          color="#0891b2"
          skew={-2}
        />
      </div>

      {/* Mode toggle - top right */}
      <div className="absolute top-6 right-6 z-20">
        <ModeToggle />
      </div>

      {/*
        top center, where "latest announcement" used to link out to github
        discussions.

        the cookie dialog was reachable from the menu and from the toast on a
        failure, and both of those need something to have already gone wrong.
        This is the one place it is offered before the user hits the wall - and
        someone whose downloads keep failing is far likelier to read a line
        about that than a link to an announcements page.
      */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 0.1 }}
        className="absolute top-6 left-1/2 -translate-x-1/2 z-20"
      >
        <button
          onClick={() => cookieActions.open()}
          className="text-xs text-slate-500 dark:text-slate-400 hover:text-cyan-500 dark:hover:text-cyan-400 transition-colors duration-200 hover:underline underline-offset-4"
          style={{
            fontFamily:
              'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
          }}
        >
          having trouble with downloads? try cookies
        </button>
      </motion.div>

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
            <SearchCard platform={selectedPlatform} />
          </motion.div>
        </div>
      </div>

      {/*
        the donate ask, sitting still rather than interrupting anything.

        plain words only. "Takes ongoing upkeep" was the kind of phrase that
        sounds considered when you write it and lands as corporate filler when
        somebody reads it - most people would not use "upkeep" out loud, and a
        line nobody parses cannot do any work at all. "Makes it and keeps it
        running" says the same thing in words a reader does not have to slow
        down for.

        it stays out of the first person. An earlier version said "it's just me
        back here", which put a person in front of the reader and then asked
        them for money - that reads as pleading however carefully it is worded.
        Here the one person is a detail of the sentence rather than its subject.

        two lines rather than one long one. The first carries the whole reason
        and the second the whole ask, so the eye can stop after either and
        still have the point, and neither is long enough to look like terms. Being the
        only thing along the bottom edge is what gives it weight, so the
        disclaimer and github links moved up into the menu rather than sitting
        beside it competing for the same glance.
      */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 1.0 }}
        className="absolute bottom-6 left-0 right-0 z-20"
      >
        <p
          className="text-center text-xs leading-relaxed text-slate-400 dark:text-slate-500"
          style={{
            fontFamily:
              'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
          }}
        >
          <span className="block">
            cliply is free. one person makes it and keeps it running.
          </span>
          <span className="block">
            if it&apos;s been useful,{" "}
            <a
              href="https://buymeacoffee.com/itssdevk"
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-500 underline underline-offset-4 transition-colors duration-200 hover:text-cyan-500 dark:text-slate-400 dark:hover:text-cyan-400"
            >
              buy me a coffee
            </a>
          </span>
        </p>
      </motion.div>

      {/* Subtle bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-slate-200 dark:from-slate-900 to-transparent" />
    </section>
  )
}
