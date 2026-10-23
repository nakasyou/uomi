import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
createRoot(document.getElementById('root')!).render(<App />)
import fontUrl from './assets/material-icons.woff?url'
const fontStyle = document.createElement('style')
fontStyle.textContent = `@font-face {font-family:MaterialDesignIcons;src:url('${fontUrl}') format('woff');font-display:block}`
document.head.appendChild(fontStyle)
