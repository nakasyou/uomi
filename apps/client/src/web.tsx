import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
createRoot(document.getElementById('root')!).render(<App />)
import fontUrl from './assets/material-icons.woff?url'
const fontStyle = document.getElementById('uomi-icon-font') as HTMLStyleElement
fontStyle.textContent = `@font-face {font-family:MaterialDesignIcons;src:url('${fontUrl}') format('woff');font-display:block}`
