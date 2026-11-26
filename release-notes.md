RiddimX 0.6.0 — go live: a link to listen online, a guest DJ in your session, AI FIRE and dub scenes

Go live (new)
- GO LIVE on the top bar gives a link: anyone who opens it hears your master mix live, in the browser, with almost no delay. No account, nothing to install for the listener.
- The app opens the port on your router by itself (UPnP / NAT-PMP) and tells you what kind of network you are on. When your network blocks it (double NAT, CGNAT), it can go through your own RiddimX server instead (see docs/SERVIDOR-ORACLE.md to set one up for free).
- The number of listeners follows your upload: if it gets tight, the sound drops a little in quality and new listeners wait.

Guest DJ (new)
- Invite another RiddimX user into your session: they get a deck and play along with you; the sound is made on your side, so the mix stays in time.

Dub
- AI FIRE (DUB page): arms a Dub Box shot for the next good moment — end of a phrase, a gap in the vocal, a break — with a countdown and what it is about to do. Press again to cancel.
- FX page: four dub effects (DUB ECHO, SPRING, SWEEP, PLATE), ready-made scenes and AI DUB pads that listen to the stems and ride the sends in time.
- Scenes switch off again: press the lit scene and everything goes back to how it was.

Cleaner centre pages
- DUB: everything FIRE on top (its sound, HOLD / LATCH, DROP · FIRE · FX), the pads in their own group below. The old "SOUND" keys that only changed the FIRE sound are gone (the sound menu does that).
- DECK DUB, TAPE and MIC follow the same pattern: group titles on the left, ⋯ on the right for every setting, no empty space at the bottom.

Fixes
- Sound kept going to the computer's speakers after an update instead of the audio interface: the app no longer forgets the chosen interface when it is not there yet at start-up. It plays on the system default meanwhile, says so in Settings › Audio, and goes back to the interface by itself when it appears. It also finds the same interface again if its id changed.
- New RESET AUDIO key in Settings › Audio: forgets only the audio settings (library and pads stay).
- The mixer now has its full width in SIMPLE mode and on wide / ultrawide screens.
