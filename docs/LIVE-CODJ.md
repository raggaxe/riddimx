# GO LIVE and guest co-DJ

Status (2026-11-26): the listen link works, and so does the first version of co-DJ, where the guest steers one deck. Both were tested end to end on the local network. Self-hosted: no account or relay of any kind. The only outside contact is a public STUN server (no account), which echoes the line's public address back.

## Choices made

| | Chosen | Alternatives considered |
|---|---|---|
| Transport | WebRTC: one call per listener, Opus stereo at 160 kbps, under 1 s of delay | Icecast-style HTTP stream (1–3 s delay, simpler, works on any network); HLS on a CDN (6–20 s delay, needs an account and a server) |
| Internet | The app opens the port on the router itself (UPnP IGD, then NAT-PMP), and the link is `http://<public IP>:<port>`. It detects double NAT and CGNAT and explains them; otherwise you forward the port by hand | ngrok (dropped: needs an account); Cloudflare quick tunnel |
| Co-DJ | A guest app connects to the host app. The host's engine renders all audio, and the guest steers one deck over a data channel | A web page for the guest; both engines rendering in sync |

## How it works

- `electron/live.cjs` is the HTTP and WebSocket server on port 7380 (any free port if 7380 is taken). It only does signalling, and serves `listen.html`. On GO LIVE it calls `openPort` (`electron/portmap.cjs`), which renews the mapping every 20 min and removes it on STOP.
  - Each GO LIVE makes two new secrets. `?k=` can only listen. `?g=` lets one guest in.
  - Limits: 40 listeners as a hard ceiling, and 1 guest. The real cap follows the upload (next point).
- **Cap based on upload** (`live.ts checkUpload`): every 2 s the app reads the listeners' RTCP reports. When at least 2 listeners (or all, if there are fewer) show more than 5% loss or a round trip over 600 ms, everyone drops to 96 kbps and new listeners get "room is full". Quality goes back to 160 kbps after 10 s without trouble.
- **`electron/portmap.cjs`** (no dependency):
  - SSDP finds the router, then SOAP `AddPortMapping` / `GetExternalIPAddress` / `DeletePortMapping` (falling back to a permanent lease on error 725). NAT-PMP (UDP 5351) is the fallback.
  - A minimal STUN client finds the public IP.
  - Verdict:
    - `open`: the router holds the public IP.
    - `double`: the router's WAN side is private or empty while STUN sees a public IP.
    - `cgnat`: the WAN address is in 100.64/10, or it differs from what STUN sees.
    - `closed`: the router refused.
- **Plain HTTP** is fine for listeners: `RTCPeerConnection` does not require a secure context. Tested on `http://192.168.68.114:7380` in Chromium.
- `src/live.ts` runs on both sides.
  - **Host:** audio flows `mixer.masterOut` → `gate` → `MediaStreamDestination` → one `RTCPeerConnection` per listener. Each offer carries its full set of ICE candidates (no trickle). STUN comes from Google and Cloudflare. The answer is munged to `stereo=1` with `maxaveragebitrate=160000`.
  - **Guest:** the guest gets the same master, plus an `RTCDataChannel` called `ctl`. That channel carries the phone controller's protocol (`controlMessage` in `src/remote.ts`).
  - **Deck lock:** with `only='A'|'B'`, the host accepts only `deckX.*`, `touch`/`turn`/`load` for that deck, and `lib`. It ignores the crossfader, the other deck, and the panels.
- **YouTube and Spotify are never broadcast.** While one of those decks is audible (playing, volume above 0, and its crossfader side open), the `gate` goes to 0. Listeners then see "Back in a moment", and the top bar shows `HELD`.
- **PANIC restart or window reload:** the server stays up. On reload, `live.ts` takes the set back (`liveReset`), and listener pages reconnect on their own.
- **UI:**
  - Clicking `LIVE n` opens a panel with the reach status, what to do (port forwarding, bridge mode, CGNAT), and the INTERNET and THIS NETWORK links.
  - The top bar has `LiveBar` with `GO LIVE` / `JOIN`, and once live it shows `LIVE n` / `COPY LINK` / `INVITE` or `GUEST A|B` / `STOP`. Clicking `GUEST X` gives the guest the other deck, and right-clicking it removes the guest.
  - The guest sees `GuestPanel` in the top-right corner. It has transport, hot cues 1–4, loops, VOL/PITCH/EQ/FILTER sliders, and the host's library with LOAD.

## Tested (2026-11-26, two Electron instances plus a browser)

- This network's router (a Deco M5 running miniupnpd) opened the port through UPnP, and STOP removed it (`GetSpecificPortMappingEntry` returned 714). The verdict was `double`: the M5 sits behind the provider's modem, so the internet link needs a port forward on the modem.
- Listener over the LAN (and, in the first version, over ngrok): L/R stereo test tones arrived on the correct sides, at ~162 kbps. "Now playing" and the listener count updated.
- `STOP`: the listener page showed "The DJ ended the live set", and the guest saw "The host ended the session". Afterwards `masterOut` still carried signal.
- YouTube gate (simulated): the listener got silence and "Back in a moment".
- Guest:
  - PLAY on the guest started the host's deck B, and the guest heard the master in stereo.
  - Commands for deck A and the crossfader were ignored.
  - After the host handed over deck A, deck B was locked to the guest.
  - Joining over the LAN (plain http) worked too, and so did the ngrok link in the first version.
- Window reload in the middle of a live set: the app went back on air by itself.

## Latency

The goal is latency as close to zero as possible. That rules out RTMP→HLS (5–30 s) and Icecast (2–10 s).

- **Receivers:** listeners and the guest set `jitterBufferTarget = 0` and `playoutDelayHint = 0`. The buffer still grows on its own when packets are lost, but never more than needed.
- **Processing:** the outgoing track comes from `MediaStreamAudioDestinationNode`, not from `getUserMedia`. It therefore has no echo cancellation, noise suppression or AGC to turn off.
- **Budget:** about 20 ms of Opus frame, plus network, plus a minimal jitter buffer. That is typically 100–300 ms, plus the time the audio card takes.
- **Scaling** past about 20 listeners: use an SFU through WHIP (the app publishes once) and WHEP (the page plays). Without accounts, that means a self-hosted SFU (LiveKit or mediamtx) on the user's own machine or server.

## Fallback to your own server (option C)

GO LIVE first tries the direct path. If the verdict is anything but `open` (double NAT, CGNAT, refused), the app goes through the relay on its own. End users configure nothing.

**Server:** the `server/` folder holds LiveKit (SFU plus TURN), `relay/index.mjs` (tokens and the https listener page) and Caddy (TLS), all wired up in `docker-compose.yml` and `install.sh`. Setup is in `server/README.md`.

**App:**
- `src/relay.ts` handles the config. The address and key are built in (`VITE_RELAY_URL` / `VITE_RELAY_KEY`), and the LIVE panel (SERVER field) can override them on one computer.
- `live.ts startRelay` publishes `tap` into the room: Opus stereo at 160 kbps, `dtx: false`, `red: false`.
  - The host sends "now playing" and `off` as data messages to everyone.
  - The snapshot goes only to the guest.
  - The guest's controls come back through `controlMessage`, with the same deck lock.
- **Guest:** JOIN calls `/api/token?g=` on the invite's origin. If the answer is JSON, it joins the room. Otherwise it uses the direct connection.
- **Reload or PANIC restart:** the set is kept in `sessionStorage`, so the links stay the same. The guest waits 20 s for the host to come back.
- **Heartbeat:** the app sends a PUT every 60 s, and the server drops a set that has been silent for 3 min.

**Tested locally (2026-11-26)** with `livekit-server --dev` and the relay on :8080 (no Caddy or Docker, which aren't installed):
- The automatic fallback happened, since this house is on double NAT.
- The relay listener got L/R stereo, "now playing" and the count.
- The guest controlled deck B (first command ~1.5 s while the channel opened, ~100 ms after that). Commands for deck A were ignored.
- After a host reload, the link stayed the same, and both the listener and the guest came back.
- On STOP, the guest saw "host ended", and the token returned "not on air".

**Not tested:** the Docker, Caddy and TLS stack on a real VPS, and TURN for a listener on 4G.

## Phone controller from anywhere (2026-11-26)

- **App:** `src/phoneRelay.ts` follows `remote`. When Phone is on and a server is configured, the app joins the room `rm-<sha256(code)>` as `desk`.
  - Phone messages go to `controlMessage`, with full control, the same as on the Wi-Fi.
  - The snapshot goes out every 80 ms, only when it changed.
  - A phone's mic arrives as a track and goes to `mic.usePhone`.
- **Relay:** `POST /api/remote {code}` plus a heartbeat. `/api/token?r=` gives a phone its token (data and microphone only). `/r/?k=` serves `remote.html` with `phone-bridge.js`, a socket with the same shape that goes through LiveKit.
- **`remote.html`:** if `window.RxSocket` exists, it uses that for the connection and for the mic, publishing the mic as a track.
- **UI:** Settings › Phone › Connect has a WI-FI / ANYWHERE switch, so the panel doesn't scroll.
- **Tested locally:** the page connected through the relay and got the state. Commands came back in ~62 ms. Turning Phone off showed the overlay, and turning it on again made the phone reconnect by itself.
- **Not tested:** the mic through the relay (the browser pane has no microphone), and a real phone on 4G.


- **No TURN server.** A listener behind strict NAT (some 4G/5G CGNAT, corporate networks) may fail to connect, and the page then says "Your network blocked the stream". The self-hosted fix is a TURN server built into the app, with a mapped UDP port. It is not built yet.
- **Mapping covers TCP signalling only.** Media goes over UDP through ICE hole punching (STUN). That usually works on home NATs.
- **Upload.** Each listener costs about 160 kbps of the DJ's upload. 20 listeners come to about 3.2 Mbps.
- **The link contains the home's public IP,** which WebRTC reveals to listeners anyway. A dynamic IP changes the link, and so does every new GO LIVE (new secret).
- **No HTTPS on the public link.** The page works without it, but the browser shows "Not secure".
- **Not yet tested:**
  - the internet link from outside, which this house's double NAT prevents;
  - iPhone Safari;
  - the upload cap under real congestion.
- **Guest view:** the guest's own app keeps showing its (empty) local decks under the panel.

## Next steps for co-DJ

1. **Guest audio:** add a sendrecv transceiver to the guest call. The guest's microphone (`getUserMedia`) goes to the host, which feeds it into the voice channel the way `phoneMic.ts` does (`mic.usePhone`), as a separate input.
2. **Guest tracks:** let the guest send a file from their own library over the data channel, in 16 KB chunks. The host saves it into its own library, then loads it on the guest's deck. That removes the need for both libraries to have the same tracks.
3. **Guest view:** in guest mode, replace the screen's deck for that side with the host's deck: waveform from the snapshot, and the jog sending `touch`/`turn`. Hide the guest's local decks.
4. **Shared FX and transitions:** let the host allow it per category (`moves.*`, `dubbox.*`, `rack.*`), with a "guest may use" checklist.
5. **Latency:** the guest's commands go out immediately, but the sound the guest hears comes back ~150–400 ms later. Show the guest a local position estimate (pos + rate × elapsed) between snapshots.
