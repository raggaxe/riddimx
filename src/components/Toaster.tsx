import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { toast, toasts, type Toast } from '../toasts'

/** The toasts, bottom-right over everything: newest on top, each with its own close key. */
export function Toaster() {
  const { list } = useStore(toasts)
  if (!list.length) return null
  return (
    <section
      className="toaster"
      aria-label="Messages"
      onPointerEnter={() => toasts.hold(true)}
      onPointerLeave={() => toasts.hold(false)}
    >
      {list.map((t) => (
        <ToastCard key={t.id} t={t} />
      ))}
    </section>
  )
}

function ToastCard({ t }: { t: Toast }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={'toast ' + t.kind} role={t.kind === 'error' ? 'alert' : 'status'} aria-live={t.kind === 'error' ? 'assertive' : 'polite'}>
      <div className="toast-top">
        <b className="toast-title">{t.title}</b>
        <button className="toast-x" onClick={() => toasts.dismiss(t.id)} aria-label="Close" title="Close">
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {t.body && <p className="toast-body">{t.body}</p>}
      {t.progress !== undefined && (
        <div className="toast-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(t.progress * 100)}>
          <i style={{ width: Math.round(t.progress * 100) + '%' }} />
        </div>
      )}
      {t.details && (
        <>
          <button className="toast-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {(t.detailsLabel ?? 'Details') + (open ? ' ▴' : ' ▾')}
          </button>
          {open && <pre className="toast-details">{t.details}</pre>}
        </>
      )}
      {t.actions && t.actions.length > 0 && (
        <div className="toast-actions">
          {t.actions.map((a) => (
            <button
              key={a.label}
              className={'toast-btn' + (a.primary ? ' primary' : '')}
              onClick={() => {
                a.run()
                if (!a.keep) toasts.dismiss(t.id)
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A panel's own error (kept in its local state) shown as a toast while it is set. */
export function useToastError(key: string, title: string, message: string | null | undefined | false): void {
  useEffect(() => {
    if (message) toast.error(title, message, { key })
    else toasts.dismissKey(key)
  }, [key, title, message])
}
