import { extendTheme } from '@chakra-ui/react'

const theme = extendTheme({
  fonts: {
    heading: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    body: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  colors: {
    brand: {
      50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd',
      400: '#60a5fa', 500: '#2563eb', 600: '#1d4ed8', 700: '#1e40af',
    },
    linkedin: { 500: '#0a66c2', 50: 'rgba(10,102,194,0.08)' },
    gmb: { 500: '#ea4335', 50: 'rgba(234,67,53,0.08)' },
  },
  styles: {
    global: {
      body: { bg: 'white', color: '#1a1a2e', WebkitFontSmoothing: 'antialiased' },
    },
  },
})

export default theme
