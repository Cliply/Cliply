import { Link } from "react-router-dom"
import { ModeToggle } from "../components/ui/mode-toggle"
import { motion } from "framer-motion"

export function DisclaimerPage() {
  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Background gradients matching HeroSection */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 dark:opacity-100 opacity-0 transition-opacity duration-300" />
      <div className="absolute inset-0 bg-gradient-to-br from-slate-50 via-slate-100 to-slate-200 dark:opacity-0 opacity-100 transition-opacity duration-300" />
      
      {/* Subtle noise texture overlay */}
      <div className="absolute inset-0 opacity-10 dark:opacity-20 transition-opacity duration-300">
        <div className="h-full w-full bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8ZGVmcz4KICAgIDxwYXR0ZXJuIGlkPSJub2lzZSIgd2lkdGg9IjQiIGhlaWdodD0iNCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CiAgICAgIDxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiNmZmZmZmYiIG9wYWNpdHk9IjAuMSIvPgogICAgPC9wYXR0ZXJuPgogIDwvZGVmcz4KICA8cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI25vaXNlKSIvPgo8L3N2Zz4K')] opacity-50" />
      </div>

      {/* Content */}
      <div className="relative z-10 min-h-screen px-4 py-16">
        {/* Mode toggle - top right */}
        <div className="absolute top-6 right-6">
          <ModeToggle />
        </div>
        
        {/* Back button - top left */}
        <div className="absolute top-6 left-6">
          <Link
            to="/"
            className="text-sm text-slate-600 dark:text-slate-400 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
            style={{
              fontFamily: 'Space Grotesk, system-ui, -apple-system, sans-serif'
            }}
          >
            ← home
          </Link>
        </div>

        {/* Main content */}
        <motion.div 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="max-w-3xl mx-auto text-center pt-20"
        >
          {/* Title */}
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="text-2xl font-normal text-slate-900 dark:text-white mb-12 tracking-wide"
            style={{
              fontFamily: 'Space Grotesk, system-ui, -apple-system, sans-serif'
            }}
          >
            about
          </motion.h1>

          {/* Content */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.4 }}
            className="text-left max-w-2xl mx-auto"
            style={{
              fontFamily: 'Space Grotesk, system-ui, -apple-system, sans-serif'
            }}
          >
            <div className="text-slate-700 dark:text-slate-300 leading-7 space-y-6 text-base">
              <p>
                cliply is a simple desktop tool to download videos. it's built around yt-dlp which does all the heavy lifting behind the scenes.
              </p>
              
              <p>
                this is not a standalone video downloader it depends on yt-dlp. if it's not already set up, cliply will try to configure it for you. we're not affiliated with yt-dlp, youtube-dl, or any of their forks. you can check out yt-dlp here they've got full docs if you want to go deeper.
              </p>
              
              <p>
                you're using yt-dlp at your own risk. cliply's just a visual layer to make things easier.
              </p>
              
              <div className="space-y-3">
                <p>by using cliply, you agree to:</p>
                <p className="pl-4">not use it for anything illegal</p>
                <p className="pl-4">not use it to download or share copyrighted stuff</p>
                <p className="pl-4">not distribute harmful, adult, violent, or unauthorized content</p>
                <p className="pl-4">follow the rules and laws in your country</p>
              </div>
              
              <div className="space-y-3">
                <p className="font-medium text-slate-800 dark:text-slate-200">license & disclaimer</p>
                <p>
                  cliply is offered as is, with no guarantees. there might be bugs, things may break, or features might change. we're not responsible for anything that happens if you use this tool the wrong way.
                </p>
              </div>
              
              <div className="space-y-3">
                <p className="font-medium text-slate-800 dark:text-slate-200">privacy</p>
                <p>
                  cliply doesn't collect any personal data. your preferences are stored locally on your device. some non-personal info like your OS or app version might be used to fetch updates or improvements. nothing is ever shared or sold.
                </p>
                <p>
                  if you're submitting feedback (like via <a href="https://cliply.space/hey" target="_blank" rel="noopener noreferrer" className="text-cyan-600 dark:text-cyan-400 hover:underline">cliply.space/hey</a>), you're willingly sending info our way we'll only use it to improve cliply.
                </p>
              </div>
              
              <div className="space-y-3">
                <p className="font-medium text-slate-800 dark:text-slate-200">updates & changes</p>
                <p>
                  this policy might change in future versions. updates go live as soon as they're released. if anything major changes, we'll let you know inside the app or through the official site.
                </p>
              </div>
            </div>

            {/* Action button */}
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.6 }}
              className="mt-12 text-center pb-16"
            >
              <Link
                to="/"
                className="inline-flex items-center justify-center px-8 py-3 rounded-xl bg-cyan-600 hover:bg-cyan-700 text-white font-medium transition-all duration-200 border-2 border-cyan-600 hover:border-cyan-700 shadow-lg hover:shadow-xl"
                style={{
                  fontFamily: 'Space Grotesk, system-ui, -apple-system, sans-serif'
                }}
              >
                let's go
              </Link>
            </motion.div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  )
}