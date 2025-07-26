import { HashRouter, Route, Routes } from "react-router-dom"
import { ThemeProvider } from "./components/theme-provider"
import "./index.css"
import { Providers } from "./lib/providers"
import { DisclaimerPage } from "./pages/DisclaimerPage"
import { HomePage } from "./pages/HomePage"

function App() {
  return (
    <HashRouter>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
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
