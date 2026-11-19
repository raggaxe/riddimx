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

  if (!r.available)
    return (
      <div className="ap2 st">
        <section className="mx-sec ap2-unit">
          <header className="ap2-head">
            <b>Celular como controladora</b>
          </header>
          <p className="ph-note">Só no app do Mac: é ele que conversa com o celular pelo Wi-Fi.</p>
        </section>
      </div>
    )

  return (
    <div className="ap2 st">
      <section className="mx-sec ap2-unit" aria-label="Celular como controladora">
        <header className="ap2-head">
          <b>Celular como controladora</b>
          <span>pads, knobs, faders e jog no celular, sem fio</span>
        </header>
        <div className="ap2-body">
          <button className={'ap2-btn' + (r.on ? '' : ' st-go')} onClick={() => void remote.turn(!r.on)} disabled={r.busy}>
            {r.on ? 'DESLIGAR' : 'LIGAR'}
          </button>
          <span className="ap2-info">
            {r.error
              ? 'Não foi possível ligar: ' + r.error
              : !r.on
                ? 'Desligado: nada fica aberto na rede'
                : r.clients
                  ? r.clients === 1
                    ? 'Ligado · 1 celular conectado'
                    : 'Ligado · ' + r.clients + ' celulares conectados'
                  : 'Ligado · esperando o celular…'}
          </span>
        </div>
      </section>

      {r.on && (
        <section className="mx-sec ap2-unit" aria-label="Conectar o celular">
          <header className="ap2-head">
            <b>Conectar</b>
            <span>celular e Mac no mesmo Wi-Fi</span>
          </header>
          {url ? (
            <div className="ph-pair">
              {qr && (
                <svg className="ph-qr" viewBox={'0 0 ' + qr.n + ' ' + qr.n} role="img" aria-label="QR code do endereço">
                  <rect width={qr.n} height={qr.n} fill="#fff" />
                  <path d={qr.d} fill="#000" />
                </svg>
              )}
              <ol className="ph-steps">
                <li>Abra a câmera do celular e aponte para o QR code.</li>
                <li>Toque no link: o controle abre no navegador.</li>
                <li>
                  Se o navegador perguntar sobre <b>dispositivos por perto</b> ou <b>rede local</b>, toque em Permitir: é assim que
                  ele chega no Mac. Se negou antes, abra o link no Chrome.
                </li>
                <li>
                  Para virar app: <b>Compartilhar › Adicionar à Tela de Início</b> (iPhone) ou <b>⋮ › Adicionar à tela inicial</b>{' '}
                  (Android).
                </li>
                <li>Deixe o celular sem bloqueio de tela automático enquanto toca.</li>
              </ol>
              <div className="ph-url">
                <code>{url}</code>
                {r.urls.length > 1 && (
                  <button className="ap2-btn" onClick={() => setWhich((which + 1) % r.urls.length)} title="Outro endereço deste Mac">
                    OUTRA REDE
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="ph-note">Este Mac não está em nenhuma rede. Conecte no Wi-Fi.</p>
          )}
        </section>
      )}

      <section className="mx-sec ap2-unit" aria-label="Segurança">
        <header className="ap2-head">
          <b>Segurança</b>
        </header>
        <p className="ph-note">
          Só entra quem tem o código que vai no QR code. Se alguém da rede tiver o link e não devia, troque o código: os
          celulares conectados saem e precisam ler o QR de novo. Na primeira vez o macOS pode perguntar se o RiddimX pode
          receber conexões: responda Permitir.
        </p>
        <div className="ap2-body">
          <button className="ap2-btn" onClick={() => void remote.renew()} disabled={r.busy}>
            TROCAR CÓDIGO
          </button>
        </div>
      </section>
    </div>
  )
}
