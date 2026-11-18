import { createRoot } from 'react-dom/client'
import { App } from './App'
import { spotify } from './engine/spotify'
import './gamepad'
import './styles.css'

void spotify.handleRedirect()
createRoot(document.getElementById('root')!).render(<App />)
