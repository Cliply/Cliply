import { HashRouter, Route, Routes } from "react-router-dom"
import { ThemeProvider } from "./components/theme/theme-provider"
import "./index.css"
import { Providers } from "./lib/providers"
import { DisclaimerPage } from "./pages/DisclaimerPage"
import { HomePage } from "./pages/HomePage"

function App() {
  return (
    <HashRouter>
      {/*
        everybody lands in light.

        this was defaultTheme="system", so which cliply you met was decided by
        your os - and the toggle could not cope with that. It reads
        theme === "dark", which is false while the theme is the string "system",
        so a mac set to dark opened a dark app showing the wrong icon, and the
        first click set "dark" and changed nothing. You had to press it twice to
        reach light. With system out of the picture the theme is only ever
        "light" or "dark" and the toggle is right by construction.

        anyone who has already chosen keeps their choice: next-themes reads the
        stored value first, and defaultTheme only decides for someone who has
        never touched it.
      */}
      <ThemeProvider
        attribute="class"
        defaultTheme="light"
        enableSystem={false}
        disableTransitionOnChange
      >
        <Providers>
          <div className="min-h-screen overflow-x-hidden bg-background text-foreground">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/disclaimer" element={<DisclaimerPage />} />
            </Routes>
          </div>
        </Providers>
      </ThemeProvider>
    </HashRouter>
  )
}

export default App
