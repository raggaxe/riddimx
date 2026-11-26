import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { live } from '../live'
import { liveFeatures, relayConfig, relayEditable, setRelayConfig } from '../relay'

/** A button that copies a link and says so for a moment. */
function CopyButton({ label, text, title }: { label: string; text: string; title: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(false), 1400)
    return () => window.clearTimeout(t)
  }, [done])
  return (
    <button
      className={'lv-btn' + (done ? ' on' : '')}
      disabled={!text}
      title={title + (text ? '\n' + text : '')}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true), () => undefined)}
    >
      {done ? 'COPIED' : label}
    </button>
  )
}

/**
 * Top bar, live: GO LIVE (the listen link and a guest invite), the listener count, STOP; or JOIN to
 * steer a deck in someone else's set as their guest.
 */
export function LiveBar() {
  const s = useStore(live)
  const [joining, setJoining] = useState(false)
  const [info, setInfo] = useState(false)
  const [link, setLink] = useState('')
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (joining) field.current?.focus()
  }, [joining])

  if (!s.available || !liveFeatures) return null

  // ── this app is a guest in someone else's set ──
  if (s.joined === 'connecting' || s.joined === 'on') {
    return (
      <div className="lv-bar">
        <span className={'lv-chip' + (s.joined === 'on' ? ' on' : '')} title="You steer this deck of the host's set; their app plays the sound">
          {s.joined === 'on' ? 'GUEST · DECK ' + s.hostDeck : 'JOINING…'}
        </span>
        <button className="lv-btn" onClick={() => live.leave()}>
          LEAVE
        </button>
      </div>
    )
  }

  if (!s.on) {
    return (
      <div className="lv-bar">
        <button
          className="lv-go"
          disabled={s.busy}
          onClick={() => void live.start()}
          title={s.error ?? 'Broadcast the master mix: a link anyone can open in a browser to listen, and an invite for a guest DJ'}
        >
          {s.busy ? 'STARTING…' : 'GO LIVE'}
        </button>
        <button
          className={'lv-btn' + (joining ? ' on' : '')}
          aria-expanded={joining}
          onClick={() => setJoining(!joining)}
          title="Join someone's set as their guest DJ, with the invite link they sent you"
        >
          JOIN
        </button>
        {(joining || s.joined === 'error') && (
          <form
            className="lv-pop"
            onSubmit={(e) => {
              e.preventDefault()
              if (!link.trim()) return
              live.join(link)
              setJoining(false)
            }}
          >
            {s.joinError && <p className="lv-err">{s.joinError}</p>}
            <input
              ref={field}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="Paste the invite link"
              aria-label="Invite link"
              spellCheck={false}
            />
            <button className="lv-go" type="submit" disabled={!link.trim()}>
              JOIN
            </button>
            <button
              className="lv-btn"
              type="button"
              onClick={() => {
                setJoining(false)
                live.clearJoinError()
              }}
            >
              CANCEL
            </button>
          </form>
        )}
      </div>
    )
  }

  const i = s.info
  const relay = s.via === 'relay'
  const open = i?.reach === 'open' || relay
  const where = relay ? 'Works from anywhere, via RiddimX server' : open ? 'Works from anywhere on the internet' : 'This network only (click LIVE for why)'
  return (
    <div className="lv-bar">
      <button
        className={'lv-chip on' + (s.held || s.congested ? ' held' : '')}
        aria-expanded={info}
        onClick={() => setInfo(!info)}
        title={(s.held ? s.held + '. ' : '') + (s.congested ? 'Upload full: lower quality, new listeners wait. ' : '') + s.listeners + ' listening · ' + where}
      >
        <i aria-hidden="true" />
        {s.held ? 'HELD' : s.congested ? 'FULL' : relay ? 'LIVE · SERVER' : s.relayState === 'connecting' ? 'LIVE · …' : open ? 'LIVE' : 'LIVE · LAN'} {s.listeners}
      </button>
      <CopyButton label="COPY LINK" text={live.shareLink('listen')} title={'Listen link · ' + where} />
      {s.guest ? (
        <button
          className={'lv-btn' + (s.guest.connected ? ' on' : '')}
          onClick={() => live.setGuestDeck(s.guestDeck === 'A' ? 'B' : 'A')}
          onContextMenu={(e) => {
            e.preventDefault()
            live.kickGuest()
          }}
          title="The guest steers this deck: click to give them the other deck, right-click to send them away"
        >
          GUEST {s.guestDeck}
        </button>
      ) : (
        <CopyButton label="INVITE" text={live.shareLink('guest')} title={'Invite a guest DJ to steer deck ' + s.guestDeck + ' (they paste it in JOIN) · ' + where} />
      )}
      <button className="lv-stop" onClick={() => live.stop()} title="End the live set: listeners and guest are disconnected">
        STOP
      </button>
      {info && i && <ReachPanel />}
    </div>
  )
}

/** Where the link works, and, when the internet cannot reach this Mac, why and what to do. */
function ReachPanel() {
  const s = useStore(live)
  const i = s.info!
  const port = i.port
  const text: Record<string, string> = {
    checking: 'Asking the router to open the port…',
    open: 'The router opened port ' + port + ' (' + i.method + '). The internet link works from anywhere.',
    double:
      'Port ' + port + ' is open on this router (' + i.router + '), but there is another router in front of it (usually the internet provider\'s modem). ' +
      'To use the internet link, on that modem forward TCP port ' + port + ' to this router, or set this router to bridge / access-point mode.',
    cgnat:
      'Your provider shares one public address between many homes (CGNAT): nobody outside can reach this Mac, whatever the router does. ' +
      'Ask the provider for a public IPv4 address (often free on request). Until then, the link works on this network only.',
    unknown:
      'Port ' + port + ' is open on this router (' + i.method + '), but it did not say its internet address, so it may not reach the internet. Test the internet link from a phone on 4G.',
    closed:
      'The router did not open the port (' + (i.reachError || 'UPnP / NAT-PMP off') + '). Turn on UPnP in the router, or forward TCP port ' + port + ' to ' + (i.localIp || 'this Mac') + ' by hand in its settings' +
      (i.router ? ' (http://' + i.router + ')' : '') + '.',
  }
  return (
    <div className="lv-pop lv-reach" role="dialog" aria-label="Live link">
      {s.via === 'relay' ? (
        <p className="lv-ok">Via RiddimX server: this network cannot be reached directly, so the set goes out through your server. Works from anywhere, and listeners do not use your upload.</p>
      ) : (
        <p className={i.reach === 'open' ? 'lv-ok' : 'lv-warn'}>
          {text[i.reach] ?? ''}
          {i.reach !== 'open' && s.relayState === 'connecting' && ' Connecting to RiddimX server…'}
          {i.reach !== 'open' && s.relayState === 'error' && ' RiddimX server failed: ' + s.relayError}
          {i.reach !== 'open' && s.relayState === 'none' && (relayEditable ? ' No RiddimX server is set up in this app (below).' : ' This network only.')}
        </p>
      )}
      {s.relay && (
        <div className="lv-link">
          <span>INTERNET</span>
          <code>{s.relay.listen}</code>
          <CopyButton label="COPY" text={s.relay.listen} title="Works anywhere, through RiddimX server" />
        </div>
      )}
      {!s.relay && i.public.listen && (
        <div className="lv-link">
          <span>INTERNET</span>
          <code>{i.public.listen}</code>
          <CopyButton label="COPY" text={i.public.listen} title={i.reach === 'open' ? 'Works anywhere' : 'Works once the port is reachable (see above)'} />
        </div>
      )}
      <div className="lv-link">
        <span>THIS NETWORK</span>
        <code>{live.shareLink('listen', 'lan')}</code>
        <CopyButton label="COPY" text={live.shareLink('listen', 'lan')} title="Phones and computers on the same Wi-Fi" />
      </div>
      <p className="lv-note">
        {s.listeners} listening{s.congested ? ' · upload full: lower quality, new listeners wait' : ''}
        {s.turnedAway ? ' · ' + s.turnedAway + ' turned away' : ''}.
        {s.via === 'relay' ? ' The server sends the sound to each listener.' : ' Each listener uses about 0.16 Mbps of upload.'}
      </p>
      {relayEditable && <ServerField />}
    </div>
  )
}

/** The relay server for this computer (the app's built-in one when empty). */
function ServerField() {
  const [cfg, setCfg] = useState(relayConfig)
  const [saved, setSaved] = useState(false)
  return (
    <form
      className="lv-server"
      onSubmit={(e) => {
        e.preventDefault()
        setRelayConfig(cfg)
        setSaved(true)
        if (live.get().on && live.get().via === 'direct' && live.get().info?.reach !== 'open') void live.startRelay()
      }}
    >
      <span>SERVER</span>
      <input value={cfg.url} placeholder="https://your-server (fallback)" aria-label="RiddimX server address" spellCheck={false} onChange={(e) => (setCfg({ ...cfg, url: e.target.value }), setSaved(false))} />
      <input value={cfg.key} placeholder="key" type="password" aria-label="RiddimX server key" onChange={(e) => (setCfg({ ...cfg, key: e.target.value }), setSaved(false))} />
      <button className={'lv-btn' + (saved ? ' on' : '')} type="submit">
        {saved ? 'SAVED' : 'SAVE'}
      </button>
    </form>
  )
}
