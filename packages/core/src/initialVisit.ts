import { navigationType } from './navigationType'
import type { RouterContext } from './routerContext'
import { SessionStorage } from './sessionStorage'
import { LocationVisit, Page } from './types'
import { uid } from './uid'

export class InitialVisit {
  constructor(protected context: RouterContext) {}
  public handle(): void {
    if (!this.context.navigation.active) {
      return
    }

    if (this.context.navigation.external) {
      this.handleDefault()

      return
    }

    this.clearRememberedStateOnReload()

    const scenarios = [this.handleBackForward, this.handleLocation, this.handleDefault]

    scenarios.find((handler) => handler.bind(this)())
  }

  protected clearRememberedStateOnReload(): void {
    if (navigationType.isReload()) {
      this.context.history.deleteState(this.context.history.rememberedState)
      this.context.history.clearInitialState(this.context.history.rememberedState)
    }
  }

  protected handleBackForward(): boolean {
    if (!navigationType.isBackForward() || !this.context.history.browserHasHistoryEntry()) {
      return false
    }

    const scrollRegions = this.context.history.getScrollRegions()

    this.context.history
      .decrypt()
      .then((data) => {
        if (this.context.page.get().version !== data.version) {
          this.handleDefault()
          return
        }

        const visitId = uid()

        this.context.page.set(data, { preserveScroll: true, preserveState: true, visitId }).then(() => {
          this.context.scroll.restore(scrollRegions)
          this.context.events.fireNavigateEvent(this.context.page.get(), {
            visitId,
          })
        })
      })
      .catch(() => {
        this.context.eventHandler.onMissingHistoryItem()
      })

    return true
  }

  /**
   * @link https://inertiajs.com/redirects#external-redirects
   */
  protected handleLocation(): boolean {
    if (!SessionStorage.exists(SessionStorage.locationVisitKey)) {
      return false
    }

    const locationVisit: LocationVisit = SessionStorage.get(SessionStorage.locationVisitKey) || {}

    SessionStorage.remove(SessionStorage.locationVisitKey)

    if (typeof window !== 'undefined') {
      this.context.page.setUrlHash(window.location.hash)
    }

    this.context.history
      .decrypt(this.context.page.get())
      .then(() => {
        const visitId = uid()
        const rememberedState = this.context.history.getState<Page['rememberedState']>(
          this.context.history.rememberedState,
          {},
        )
        const scrollRegions = this.context.history.getScrollRegions()
        this.context.page.remember(rememberedState)

        this.context.page
          .set(this.context.page.get(), {
            preserveScroll: locationVisit.preserveScroll,
            preserveState: true,
            initialRender: true,
            visitId,
          })
          .then(() => {
            if (locationVisit.preserveScroll) {
              this.context.scroll.restore(scrollRegions)
            }

            this.fireInitialEvents(visitId)
          })
      })
      .catch(() => {
        this.context.eventHandler.onMissingHistoryItem()
      })

    return true
  }

  protected handleDefault(): void {
    if (typeof window !== 'undefined') {
      this.context.page.setUrlHash(window.location.hash)
    }

    const visitId = uid()

    this.context.page
      .set(this.context.page.get(), {
        preserveScroll: true,
        preserveState: true,
        initialRender: true,
        visitId,
      })
      .then(() => {
        if (this.context.navigation.external) {
          this.fireInitialEvents(visitId)

          return
        }

        if (navigationType.isReload()) {
          this.context.scroll.restore(this.context.history.getScrollRegions())
        } else {
          this.context.scroll.scrollToAnchor()
        }

        this.fireInitialEvents(visitId)
      })
  }

  protected fireInitialEvents(visitId: string): void {
    const page = this.context.page.get()

    this.context.events.fireNavigateEvent(page, { visitId })

    if (Object.keys(page.flash).length > 0) {
      queueMicrotask(() => {
        this.context.events.fireFlashEvent(page.flash)
      })
    }
  }
}
