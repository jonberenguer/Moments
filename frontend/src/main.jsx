// Install the native-API shim FIRST (side-effect import): it sets
// window.nativeAPI synchronously, before App and its children (useFFmpeg.js,
// MediaPanel.jsx) are imported — those capture `const api = window.nativeAPI`
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
