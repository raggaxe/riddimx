import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { remote } from '../remote'
import { qrPath } from '../qr'

/** Ajustes › Celular: the phone as a wireless controller (same Wi-Fi), paired by scanning a QR code. */
export function PhonePanel() {
  const r = useStore(remote)
  const [which, setWhich] = useState(0)
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
                : r.clients
                  ? r.clients === 1
                    ? 'On · 1 phone connected'
                    : 'On · ' + r.clients + ' phones connected'
                  : 'On · waiting for the phone…'}
          </span>
        </div>
      </section>

      {r.on && (
        <section className="mx-sec ap2-unit" aria-label="Connect the phone">
          <header className="ap2-head">
            <b>Connect</b>
            <span>phone and Mac on the same Wi-Fi</span>
          </header>
          {url ? (
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
          Only someone with the code inside the QR code gets in. If someone on the network has the link and shouldn't, change the code: connected phones drop out and need to scan the QR again. The first time, macOS may ask whether RiddimX can accept connections: answer Allow.
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
