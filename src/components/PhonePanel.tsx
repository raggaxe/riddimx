import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { remote } from '../remote'
import { qrPath } from '../qr'
import { phoneRelay } from '../phoneRelay'
import { liveFeatures, relayEditable } from '../relay'

/** Ajustes › Celular: the phone as a wireless controller (same Wi-Fi), paired by scanning a QR code. */
export function PhonePanel() {
  const r = useStore(remote)
  const pr = useStore(phoneRelay)
  const [which, setWhich] = useState(0)
  const [anywhere, setAnywhere] = useState(false)
  const url = r.urls[Math.min(which, r.urls.length - 1)] ?? ''
  const qr = useMemo(() => (url ? qrPath(url) : null), [url])
  const isName = (u: string | undefined) => !!u && /^http:\/\/[^/]+\.local:/.test(u)
  const byName = isName(url)
  const nextByName = isName(r.urls[(which + 1) % Math.max(1, r.urls.length)])

  if (!r.available)
    return (
      <div className="ap2 st">
        <section className="mx-sec ap2-unit">
          <header className="ap2-head">
            <b>Phone as a controller</b>
          </header>
          <p className="ph-note">Mac app only: it's the one that talks to the phone over Wi-Fi.</p>
        </section>
      </div>
    )

  return (
    <div className="ap2 st">
      <section className="mx-sec ap2-unit" aria-label="Phone as a controller">
        <header className="ap2-head">
          <b>Phone as a controller</b>
          <span>pads, knobs, faders and jog on the phone, wireless</span>
        </header>
        <div className="ap2-body">
          <button className={'ap2-btn' + (r.on ? '' : ' st-go')} onClick={() => void remote.turn(!r.on)} disabled={r.busy}>
            {r.on ? 'TURN OFF' : 'TURN ON'}
          </button>
          <span className="ap2-info">
            {r.error
              ? 'Couldn\'t turn on: ' + r.error
              : !r.on
                ? 'Off: nothing is open on the network'
                : r.clients + pr.phones
                  ? r.clients + pr.phones === 1
                    ? 'On · 1 phone connected'
                    : 'On · ' + (r.clients + pr.phones) + ' phones connected'
                  : 'On · waiting for the phone…'}
          </span>
        </div>
      </section>

      {r.on && (
        <section className="mx-sec ap2-unit" aria-label="Connect the phone">
          <header className="ap2-head">
            <b>Connect</b>
            <span>{anywhere ? '4G or any network, through the RiddimX server' : 'phone and Mac on the same Wi-Fi'}</span>
            {liveFeatures && (
            <span className="ph-where" role="radiogroup" aria-label="Where the phone is">
              <button role="radio" aria-checked={!anywhere} className={!anywhere ? 'on' : ''} onClick={() => setAnywhere(false)}>
                WI-FI
              </button>
              <button role="radio" aria-checked={anywhere} className={anywhere ? 'on' : ''} onClick={() => setAnywhere(true)}>
                ANYWHERE{pr.state === 'on' ? '' : pr.state === 'connecting' ? ' …' : ' ·'}
              </button>
            </span>
            )}
          </header>
          {anywhere && liveFeatures ? (
            <AnywhereBody />
          ) : url ? (
            <div className="ph-pair">
              {qr && (
                <svg className="ph-qr" viewBox={'0 0 ' + qr.n + ' ' + qr.n} role="img" aria-label="QR code of the address">
                  <rect width={qr.n} height={qr.n} fill="#fff" />
                  <path d={qr.d} fill="#000" />
                </svg>
              )}
              <ol className="ph-steps">
                <li>Open the phone's camera and point it at the QR code.</li>
                <li>Tap the link: the controller opens in the browser.</li>
                <li>
                  If the browser asks about <b>nearby devices</b> or the <b>local network</b>, tap Allow: that's how it reaches the Mac. If you denied it before, open the link in Chrome.
                </li>
                <li>
                  To make it an app: <b>Share › Add to Home Screen</b> (iPhone) or <b>⋮ › Add to Home screen</b>{' '}
                  (Android).
                </li>
                <li>Keep the phone from auto-locking while you play.</li>
                {byName && (
                  <li>
                    This link uses the Mac's name, so it keeps working when the router gives the Mac a new address. If
                    the phone can't open it, tap <b>BY NUMBER</b> and scan again.
                  </li>
                )}
              </ol>
              <div className="ph-url">
                <code>{url}</code>
                {r.urls.length > 1 && (
                  <button
                    className="ap2-btn"
                    onClick={() => setWhich((which + 1) % r.urls.length)}
                    title={byName ? "The Mac's number on this network (changes if the router gives it a new one)" : "The Mac's name (stays the same)"}
                  >
                    {byName ? 'BY NUMBER' : nextByName ? 'BY NAME' : 'OTHER ADDRESS'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="ph-note">This Mac isn't on any network. Connect to Wi-Fi.</p>
          )}
        </section>
      )}

      <section className="mx-sec ap2-unit" aria-label="Security">
        <header className="ap2-head">
          <b>Security</b>
        </header>
        <p className="ph-note">
          Only someone with the code inside the QR code gets in, on the Wi-Fi or from anywhere. If someone has the link and shouldn't, change the code: connected phones drop out and need to scan the QR again. The first time, macOS may ask whether RiddimX can accept connections: answer Allow.
        </p>
        <div className="ap2-body">
          <button className="ap2-btn" onClick={() => void remote.renew()} disabled={r.busy}>
            CHANGE CODE
          </button>
        </div>
      </section>
    </div>
  )
}

/** The same controller from 4G or another network, through the RiddimX server. */
function AnywhereBody() {
  const pr = useStore(phoneRelay)
  const qr = useMemo(() => (pr.url ? qrPath(pr.url) : null), [pr.url])
  return (
    <>
      {pr.state === 'on' && pr.url ? (
        <div className="ph-pair">
          {qr && (
            <svg className="ph-qr" viewBox={'0 0 ' + qr.n + ' ' + qr.n} role="img" aria-label="QR code of the address from anywhere">
              <rect width={qr.n} height={qr.n} fill="#fff" />
              <path d={qr.d} fill="#000" />
            </svg>
          )}
          <ol className="ph-steps">
            <li>Scan this one when the phone is not on the Mac's Wi-Fi (or always: it works on both).</li>
            <li>Each tap takes a little longer than on the Wi-Fi (it goes through the server), fine for pads and faders.</li>
            <li>USE THIS PHONE AS MIC works from here too, with no extra step.</li>
          </ol>
          <div className="ph-url">
            <code>{pr.url}</code>
          </div>
        </div>
      ) : (
        <div className="ap2-body">
          <span className="ap2-info">
            {pr.state === 'connecting'
              ? 'Connecting to the server…'
              : pr.state === 'none'
                ? relayEditable
                  ? 'This app has no RiddimX server yet (set it in the LIVE panel: GO LIVE, then click LIVE).'
                  : 'Not available in this version: use the Wi-Fi link.'
                : pr.state === 'error'
                  ? "Couldn't reach the server: " + pr.error
                  : 'Off'}
          </span>
          {(pr.state === 'error' || pr.state === 'none') && (
            <button className="ap2-btn" onClick={() => phoneRelay.retry()}>
              TRY AGAIN
            </button>
          )}
        </div>
      )}
    </>
  )
}
