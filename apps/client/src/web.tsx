import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
createRoot(document.getElementById('root')!).render(<App />)
import fontUrl from '@react-native-vector-icons/material-design-icons/fonts/MaterialDesignIcons.ttf?url'
const fontStyle = document.createElement('style')
fontStyle.textContent = `@font-face {font-family:MaterialDesignIcons;src:url('${fontUrl}') format('truetype');font-display:block}`
document.head.appendChild(fontStyle)
