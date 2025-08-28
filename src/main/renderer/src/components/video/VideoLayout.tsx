import { ModeToggle } from "@/components/ui/mode-toggle"
import {
  FeedbackCard,
  PlaylistAccessCard,
  UnifiedDownloadCard,
  VideoDetailsCard,
  VideoPlayerFrame
} from "@/components/video"
import { useServerStatus } from "@/lib/hooks/useServerStatus"
import { useAppStore } from "@/lib/store"
import {
  showServerReadyToast,
  showServerStartingToast
} from "@/lib/toast-utils"
import { motion } from "framer-motion"
import { useEffect, useRef } from "react"
import { CompactSearch } from "./CompactSearch"

export function VideoLayout() {
  const { videoInfo, url } = useAppStore()

  // Track server status and show toasts
  const serverStatus = useServerStatus()
  const prevStatusRef = useRef(serverStatus.status)

  useEffect(() => {
    const prevStatus = prevStatusRef.current
    const currentStatus = serverStatus.status

    // Only show toasts when status actually changes
    if (prevStatus !== currentStatus) {
      if (currentStatus === "starting") {
        showServerStartingToast()
      } else if (currentStatus === "ready" && prevStatus === "starting") {
        showServerReadyToast()
      }
    }

    prevStatusRef.current = currentStatus
  }, [serverStatus.status])

  if (!videoInfo) return null

  return (
    <div className="min-h-screen xl:h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100 dark:from-slate-900 dark:via-slate-800 dark:to-slate-900 flex flex-col xl:overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 p-4 lg:p-6 border-b border-slate-200/50 dark:border-slate-700/50 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          {/* Left side: Logo and brand text */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Small Logo */}
            <div 
              className="w-8 h-8 text-slate-700 dark:text-slate-300 transition-colors duration-300 cursor-pointer hover:text-slate-900 dark:hover:text-slate-100"
              onClick={() => {
                const { reset } = useAppStore.getState()
                reset()
              }}
            >
              <svg
                viewBox="0 0 100 94.27"
                className="w-full h-full"
                fill="currentColor"
              >
                <g
                  transform="translate(-2.83, -5.35) scale(0.178)"
                  stroke="currentColor"
                  fill="currentColor"
                >
                  <g
                    transform="translate(0, 600) scale(0.1, -0.1)"
                    fill="currentColor"
                    stroke="none"
                  >
                    <path d="M3823 5689 c-157 -20 -367 -116 -546 -249 -133 -99 -333 -292 -440 -425 -141 -175 -270 -385 -348 -564 l-36 -84 34 -96 c72 -201 117 -414 132 -623 4 -69 11 -131 15 -137 5 -7 41 -11 95 -11 101 0 206 24 319 72 l76 33 2 70 c6 192 135 340 391 450 74 32 185 65 265 79 42 8 81 52 183 211 400 620 402 1210 4 1275 -35 5 -68 9 -74 9 -5 -1 -38 -5 -72 -10z" />
                    <path d="M1325 5338 c-118 -44 -207 -165 -257 -349 -21 -76 -23 -106 -23 -299 0 -182 4 -232 23 -326 65 -325 166 -591 321 -852 105 -176 168 -255 211 -263 279 -56 495 -124 675 -214 l127 -62 39 59 c61 96 96 208 114 364 l7 62 -47 23 c-57 29 -125 100 -159 168 -46 89 -59 169 -52 321 5 134 13 177 56 322 l22 76 -45 101 c-100 222 -235 431 -382 588 -105 113 -192 180 -313 241 -90 45 -98 46 -190 49 -54 1 -110 -2 -127 -9z" />
                    <path d="M3953 4166 l-92 -11 -64 -75 c-144 -168 -335 -338 -499 -444 -56 -36 -88 -64 -88 -75 0 -25 66 -130 122 -195 26 -30 84 -82 128 -115 l81 -61 37 25 c58 38 121 57 197 57 179 2 351 -86 543 -278 l102 -103 111 -12 c144 -15 485 -6 602 15 143 27 256 63 367 118 132 64 234 160 269 252 105 282 -205 604 -758 786 -334 110 -741 155 -1058 116z" />
                    <path d="M995 3210 c-409 -35 -713 -176 -806 -374 -145 -307 253 -682 907 -852 254 -66 564 -95 809 -76 85 7 161 15 169 18 8 3 58 54 110 114 145 165 330 323 496 426 33 20 60 42 60 49 0 6 -14 40 -31 74 -36 72 -164 208 -247 263 l-53 36 -71 -37 c-69 -35 -74 -36 -182 -36 -105 0 -115 2 -192 36 -119 52 -217 122 -332 237 l-104 103 -71 8 c-116 15 -354 20 -462 11z" />
                    <path d="M3519 3068 c-63 -85 -110 -229 -124 -376 l-7 -67 46 -24 c57 -30 126 -103 160 -169 75 -149 75 -369 -1 -625 l-26 -87 29 -72 c16 -39 59 -128 96 -196 192 -351 431 -600 670 -694 78 -32 225 -32 289 0 103 51 187 173 230 337 30 113 37 357 15 520 -39 298 -147 617 -302 897 -55 98 -105 175 -198 301 -9 11 -41 22 -92 32 -238 42 -449 111 -644 210 l-110 55 -31 -42z" />
                    <path d="M3135 2580 c-68 -10 -156 -36 -241 -72 l-72 -30 -4 -86 c-3 -68 -10 -98 -30 -138 -94 -181 -310 -314 -609 -374 -55 -11 -57 -13 -111 -88 -428 -600 -513 -1211 -191 -1369 46 -22 74 -28 147 -31 265 -12 586 157 901 472 176 176 305 343 425 551 58 100 140 276 140 301 0 9 -14 55 -31 102 -71 200 -118 433 -134 663 l-7 97 -45 6 c-52 7 -68 6 -138 -4z" />
                  </g>
                </g>
              </svg>
            </div>

            {/* Brand text - only on desktop */}
            <span
              className="hidden lg:block text-lg font-light text-slate-700 dark:text-slate-300 tracking-tight cursor-pointer hover:text-slate-900 dark:hover:text-slate-100 transition-colors duration-300"
              onClick={() => {
                const { reset } = useAppStore.getState()
                reset()
              }}
              style={{
                fontFamily:
                  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
              }}
            >
              cliply
            </span>
          </div>

          {/* Center: Search Bar */}
          <div className="flex-1 max-w-2xl mx-auto">
            <CompactSearch />
          </div>

          {/* Right side: Mode toggle */}
          <div className="flex-shrink-0">
            <ModeToggle />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col xl:flex-row xl:overflow-hidden">
        {/* Left Column - Fixed Video Details & Player (only on xl+) */}
        <div className="w-full xl:w-2/3 flex flex-col p-3 lg:p-4 space-y-3 lg:space-y-4 xl:overflow-hidden">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex-1 flex flex-col space-y-3 lg:space-y-4 xl:overflow-y-auto xl:h-full"
          >
            {/* Download Info */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="flex-shrink-0 px-1 mb-3"
            >
              <div className="text-xs text-slate-500 dark:text-slate-400 font-space-grotesk">
                Downloads stored at{" "}
                <span className="font-mono text-slate-600 dark:text-slate-300">
                  ~/Downloads/Cliply
                </span>{" "}
                &nbsp;•&nbsp; Multiple downloads supported, performance may vary
                with concurrent downlaods.
              </div>
            </motion.div>

            {/* Video Details Card */}
            <div className="flex-shrink-0">
              <VideoDetailsCard videoInfo={videoInfo} />
            </div>

            {/* Video Player - Takes remaining space */}
            <div className="flex-1 min-h-[250px] sm:min-h-[300px] lg:min-h-[350px]">
              <div className="h-full w-full">
                <VideoPlayerFrame url={url} title={videoInfo.title} />
              </div>
            </div>
          </motion.div>
        </div>

        {/* Right Column - Scrollable Download Options */}
        <div className="w-full xl:w-1/3 border-t xl:border-t-0 xl:border-l border-slate-200/50 dark:border-slate-700/50 flex flex-col xl:overflow-hidden">
          <div className="flex-1 xl:overflow-y-auto">
            <div className="p-4 lg:p-6 space-y-4 lg:space-y-6">
              {/* Feedback Card - Help us improve / Request features */}
              <FeedbackCard />

              {/* Playlist Access Card - Provides access to playlist download features */}
              <PlaylistAccessCard />

              {/* Unified Download Card - Replaces both video and audio download cards */}
              <UnifiedDownloadCard videoInfo={videoInfo} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
