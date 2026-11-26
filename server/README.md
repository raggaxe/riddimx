# RiddimX relay server

When the DJ's home network can't be reached from the internet (double NAT, CGNAT, UPnP off), GO LIVE falls back to this server on its own. The app connects **out** to it, so it works on any home network with nothing to configure. Listeners and the guest co-DJ join here over https, and the server's upload carries the listeners, not the DJ's.

It is all open source and runs on your own machine. No accounts:

- **LiveKit** (SFU plus built-in TURN) carries the sound with WebRTC latency, well under a second.
- **relay/** is a small Node service. It hands out room tokens and serves the listener page.
- **Caddy** provides https, with an automatic Let's Encrypt certificate.

## What you need

- A small Linux server with a public IPv4 address. 1 vCPU and 1 GB RAM are enough for a few hundred listeners. Each listener costs about 160 kbps of the server's upload.
- Docker with the compose plugin.
- A domain. Without one, `install.sh` offers `<your-ip>.sslip.io`, which works with no account.

## Install

```sh
git clone <this repo>   # or copy just the server/ folder
cd server
./install.sh            # asks for the domain, makes the secrets, writes livekit.yaml
sudo docker compose up -d
```

Open these ports in the server's firewall:

| Ports | For |
|---|---|
| TCP 80, 443 | https (Caddy) |
| TCP 7881 | sound over TCP when UDP is blocked |
| UDP 3478 | TURN |
| UDP 50000–50200 | sound (WebRTC) |

Check it at `https://<domain>/health`, which should return `{"ok":true,…}`.

## Oracle Cloud Always Free (Ampere A1, arm64)

Every image runs on arm64, as checked on Docker Hub: `livekit/livekit-server:v1.13.11`, `caddy:2.8-alpine` and `node:22-alpine`.

Ports must be open in **two places**.

1. **VCN Security List.** In the console, go to Networking › Virtual Cloud Networks › the VCN › Security Lists › Default › Add Ingress Rules. Use source `0.0.0.0/0` and add:
   - TCP `80`, `443` (https and the certificate);
   - TCP `7881` (sound over TCP);
   - UDP `3478` (TURN);
   - UDP `50000-50200` (sound).
2. **The VM's own iptables.** Oracle's Ubuntu images reject everything except SSH. `install.sh` detects that and inserts the same rules, then runs `netfilter-persistent save`. To do it by hand:
   ```sh
   for p in 80 443 7881; do sudo iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT; done
   for p in 3478 50000:50200; do sudo iptables -I INPUT 1 -p udp --dport $p -j ACCEPT; done
   sudo netfilter-persistent save
   ```

**Notes:**
- **Public IP:** the VM only sees a private IP (10.0.x.x). `install.sh` asks for the public one (on the instance page), uses it in `<ip>.sslip.io` for TLS without a domain, and pins it as LiveKit's `node_ip`.
- **Reserve the public IP** (Networking › Reserved Public IPs, free). If you don't, the IP, and with it the sslip.io name and the app's built-in link, changes when the VM is recreated.
- **TURN:** LiveKit's TURN uses UDP 3478 here. Clients that can't use UDP fall back to TCP 7881 straight to the server (ICE-TCP). TURN over TLS on 443 is only needed on networks that block everything except 443, and it isn't set up.
- **Traffic:** Always Free includes 10 TB of egress per month. At 160 kbps, one listener uses about 72 MB per hour, so that's roughly 140,000 listener-hours per month.

## Point the app at it

When you build the app, set the two values that `install.sh` prints:

```sh
VITE_RELAY_URL=https://<domain> VITE_RELAY_KEY=<key> npm run package
```

To try a server without rebuilding, open the LIVE panel in the app (GO LIVE, then click `LIVE`) and fill in SERVER on that computer.

## Phone controller from anywhere

While Phone is on in the app's Settings, the app keeps a room for its phones on this server. The ANYWHERE QR in Settings › Phone opens `https://<domain>/r/?k=<code>`, which is the same controller page as on the Wi-Fi, talking through LiveKit, and the phone microphone goes up as a track.

`relay/remote.html` is a copy of `electron/remote.html`. After changing the phone page, run `npm run relay:sync` in the app repo and redeploy the server.

## Limits and safety

- **The key is inside the app.** `RELAY_KEY` only lets someone open sets, and anyone with the app can extract it. To keep the server from being abused:
  - at most `MAX_SETS` sets at once (default 20);
  - a set lasts at most `SET_HOURS` (default 12);
  - a set whose app stops sending its heartbeat for 3 min is dropped.
- **Who can do what:**
  - Listeners can only receive.
  - The guest can receive and send controls, but can't publish sound.
  - A phone can send controls and its microphone, and receives nothing but data from the app.
  - Only the host publishes.
- **Updating:** run `docker compose pull && docker compose up -d --build`.

## Test locally (no Docker)

```sh
livekit-server --dev --bind 127.0.0.1                     # brew install livekit
PORT=8080 PUBLIC_URL=http://127.0.0.1:8080 LIVEKIT_WS=ws://127.0.0.1:7880 RELAY_KEY=test node relay/index.mjs
```

Then, in the app's LIVE panel, set SERVER to `http://127.0.0.1:8080` with key `test`.
