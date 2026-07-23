import { App } from '@capacitor/app'
import { useEffect, useRef } from './html'

/**
 * Register the Android hardware back handler exactly once.
 *
 * The handler is read through a ref rather than captured in the effect, so the
 * listener is registered a single time yet always invokes the CURRENT render's
 * closure (which is what sees up-to-date stack state). Registering with
 * `[handler]` instead would tear down and re-add the native listener on every
 * render.
 */
export function useBackButton(handler: () => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    let remove: (() => void) | undefined
    let cancelled = false
    void App.addListener('backButton', () => ref.current()).then(h => {
      // The component may have unmounted while addListener was still pending.
      if (cancelled) void h.remove()
      else remove = () => { void h.remove() }
    })
    return () => { cancelled = true; remove?.() }
  }, [])
}

/** Close the app. Only called at the root, on a confirmed double-tap. */
export function exitApp(): void {
  void App.exitApp()
}
