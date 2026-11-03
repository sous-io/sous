import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"

// The saved choice, or the system's.
let theme: string | null = null
try {
  theme = localStorage.getItem("sous-theme")
} catch {
  // Not remembered; use the system's.
}
const dark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches
document.documentElement.classList.toggle("dark", dark)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
