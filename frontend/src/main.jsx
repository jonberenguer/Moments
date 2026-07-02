// Install the Wails→Electron shim FIRST (side-effect import): it sets
// window.electronAPI synchronously, before App and its children (useFFmpeg.js,
// MediaPanel.jsx) are imported — those capture `const api = window.electronAPI`
// at module scope, so the shim must exist by then.
import './wailsShim.js'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
