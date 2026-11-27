RiddimX 0.6.1 — messages as toasts, no more YouTube videos that can't play

Messages (new)
- Every error and warning now shows up as a toast in the bottom-right corner, with a close key: decks, audio output, a disconnected audio interface, microphone, MIDI, library, AI install, joining a live session. The red lines inside the panels are gone, so the same error never shows twice.
- The same subject replaces its old toast instead of stacking up; errors go by themselves after a few seconds and stay while the pointer is over them.
- A blocked YouTube video on a deck offers FIND ON YOUTUBE; a microphone without permission offers OPEN SETTINGS.

Updates
- A new version shows as a toast: "What's new" opens these notes, DOWNLOAD fetches it (Mac) or opens its page (Windows), NOT NOW asks again on the next start.
- On the Mac the update is no longer downloaded without asking: only after DOWNLOAD, with its progress in the toast, then RESTART & UPDATE.

YouTube
- Videos whose owner only lets them play on youtube.com no longer get into the library: the app tries each pasted link in a hidden, muted player first and says why it was not added.
- Links already in the library are checked once in the background; the ones that can't play are taken out, with one message listing them.

For now
- The Spotify tab is put away: Spotify only plays its protected audio inside an app signed for it, which RiddimX is not yet. It comes back when it is.

Fixes
- Spotify login now opens in its own window, so a wrong Client ID can no longer replace the app with Spotify's error page.
