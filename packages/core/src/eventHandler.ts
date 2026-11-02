import { get } from 'es-toolkit/compat'
import debounce from './debounce'
import type { RouterContext } from './routerContext'
import { GlobalEvent, GlobalEventNames, GlobalEventResult, InternalEvent } from './types'
import { hrefToUrl } from './url'

export class EventHandler {
  constructor(protected context: RouterContext) {}
  protected internalListeners: {
    event: InternalEvent
    listener: (...args: any[]) => void
  }[] = []

  protected onWindowScroll = debounce(() => this.context.scroll.onWindowScroll(), 100)
  protected onScroll = debounce((event: Event) => this.context.scroll.onScroll(event), 100)

  public init(external = false): VoidFunction {
    if (external) {
      return () => {}
    }

    const controller = new AbortController()
    const popstate = this.handlePopstateEvent.bind(this)
    const pageshow = this.handlePageshowEvent.bind(this)

    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', popstate, {
        signal: controller.signal,
      })
      window.addEventListener('pageshow', pageshow, {
        signal: controller.signal,
      })
      window.addEventListener('scroll', this.onWindowScroll, {
        capture: true,
        signal: controller.signal,
      })
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('scroll', this.onScroll, {
        capture: true,
        signal: controller.signal,
      })
    }

    return () => {
      controller.abort()
      this.onWindowScroll.cancel()
      this.onScroll.cancel()
    }
  }

  public onGlobalEvent<TEventName extends GlobalEventNames>(
    type: TEventName,
    callback: (event: GlobalEvent<TEventName>) => GlobalEventResult<TEventName>,
  ): VoidFunction {
    const listener = ((event: GlobalEvent<TEventName>) => {
      const response = callback(event)

      if (event.cancelable && !event.defaultPrevented && response === false) {
        event.preventDefault()
      }
    }) as EventListener

    return this.registerListener(`inertia:${type}`, listener)
  }

  public on(event: InternalEvent, callback: (...args: any[]) => void): VoidFunction {
    this.internalListeners.push({ event, listener: callback })

    return () => {
      this.internalListeners = this.internalListeners.filter((listener) => listener.listener !== callback)
    }
  }

  public onMissingHistoryItem() {
    // At this point, the user has probably cleared the state
    // Mark the current page as cleared so that we don't try to write anything to it.
    this.context.page.clear()
    // Fire an event so that that any listeners can handle this situation
    this.fireInternalEvent('missingHistoryItem')
  }

  public fireInternalEvent(event: InternalEvent, ...args: any[]): void {
    for (const listener of this.internalListeners.filter((listener) => listener.event === event)) {
      if (!this.context.navigation.active) {
        return
      }

      listener.listener(...args)
    }
  }

  protected registerListener(type: string, listener: EventListener): VoidFunction {
    document.addEventListener(type, listener)

    return () => document.removeEventListener(type, listener)
  }

  // bfcache restores pages without firing `popstate`, so we use `pageshow` to
  // re-validate encrypted history entries after `clearHistory()` removed the keys.
  // https://web.dev/articles/bfcache
  protected handlePageshowEvent(event: PageTransitionEvent): void {
    if (event.persisted) {
      this.context.history.decrypt().catch(() => this.onMissingHistoryItem())
    }
  }

  protected handlePopstateEvent(event: PopStateEvent): void {
    this.onWindowScroll.cancel()
    this.onScroll.cancel()

    const state = event.state || null

    if (state === null) {
      const url = hrefToUrl(this.context.page.get().url)
      url.hash = window.location.hash

      this.context.history.replaceState({
        ...this.context.page.getWithoutFlashData(),
        url: url.href,
      })
      this.context.scroll.reset()

      return
    }

    if (!this.context.history.isValidState(state)) {
      return this.onMissingHistoryItem()
    }

    // Cancel ongoing requests except prefetch requests before decrypting,
    // so a response that arrives in the meantime can't replace the restored page
    this.context.router.cancelAll({ prefetch: false })

    this.context.history
      .decrypt(state.page)
      .then((data) => {
        if (this.context.page.get().version !== data.version) {
          this.onMissingHistoryItem()
          return
        }

        this.context.page.setQuietly(data, { preserveState: false }).then(() => {
          this.context.scroll.restore(this.context.history.getScrollRegions())
          this.context.events.fireNavigateEvent(this.context.page.get(), { type: 'history' })

          const pendingDeferred: Record<string, string[]> = {}
          const pageProps = this.context.page.get().props

          for (const [group, props] of Object.entries(data.initialDeferredProps ?? data.deferredProps ?? {})) {
            const missing = props.filter((prop) => get(pageProps, prop) === undefined)

            if (missing.length > 0) {
              pendingDeferred[group] = missing
            }
          }

          if (Object.keys(pendingDeferred).length > 0) {
            this.fireInternalEvent('loadDeferredProps', pendingDeferred)
          }
        })
      })
      .catch(() => {
        this.onMissingHistoryItem()
      })
  }
}
