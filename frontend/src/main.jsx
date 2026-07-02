import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { installElectronShim } from './wailsShim.js'

// Install the Wails→Electron compatibility shim before first render so that
// window.electronAPI (incl. the synchronous .platform value) is available to
// components. In a plain browser (no Wails runtime) this is a no-op and the app
// falls back to its browser code paths.
installElectronShim().finally(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
})
