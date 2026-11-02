import { get } from 'es-toolkit/compat'
import { RefreshFilter, visitRefreshesProp } from './partialReload'
import type { RouterContext } from './routerContext'
import { ActiveVisit, Page } from './types'
import { hrefToUrl, isSameUrlWithoutQueryOrHash } from './url'

export class PropRefreshes {
  protected activeVisits = new Map<string, RefreshFilter>()
  protected listeners = new Set<VoidFunction>()
  protected pendingDeferredProps: RefreshFilter | null = null

  constructor(protected context: RouterContext) {}

  protected notify(): void {
    if (this.context.navigation.active) {
      this.listeners.forEach(this.context.callback((listener) => listener()))
    }
  }

  /**
   * Prefetches and requests aimed at another page are ignored, since neither
   * refreshes the props you're looking at.
   */
  public track(visit: ActiveVisit): void {
    if (typeof window === 'undefined' || visit.prefetch || !this.context.navigation.active) {
      return
    }

    const pageUrl = this.context.navigation.external ? hrefToUrl(this.context.page.get().url) : window.location

    if (!isSameUrlWithoutQueryOrHash(visit.url, pageUrl)) {
      return
    }

    this.activeVisits.set(visit.id, { only: visit.only, except: visit.except, reset: visit.reset })

    this.notify()
  }

  /**
   * Deferred props are only requested once their page has rendered, so the ones
   * a page is about to load count as refreshing until those requests start.
   */
  public setPendingDeferredProps(props: Page['props'], deferredProps: Page['deferredProps']): void {
    if (typeof window === 'undefined' || !this.context.navigation.active) {
      return
    }

    const missing = Object.values(deferredProps ?? {})
      .flat()
      .filter((prop) => get(props, prop) === undefined)

    if (missing.length === 0) {
      this.clearPendingDeferredProps()

      return
    }

    this.pendingDeferredProps = { only: missing, except: [], reset: [] }

    this.notify()
  }

  public clearPendingDeferredProps(): void {
    if (this.pendingDeferredProps === null) {
      return
    }

    this.pendingDeferredProps = null

    this.notify()
  }

  public untrack(visit: ActiveVisit): void {
    if (this.activeVisits.delete(visit.id)) {
      this.notify()
    }
  }

  public isRefreshing(prop: string): boolean {
    for (const visit of this.activeVisits.values()) {
      if (visitRefreshesProp(visit, prop)) {
        return true
      }
    }

    return this.pendingDeferredProps !== null && visitRefreshesProp(this.pendingDeferredProps, prop)
  }

  public onChange(listener: VoidFunction): VoidFunction {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  public dispose(): void {
    this.listeners.clear()
    this.activeVisits.clear()
    this.pendingDeferredProps = null
  }
}
