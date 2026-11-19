import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { createApiClient } from './lib/api'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={createApiClient()} />
  </StrictMode>,
)
