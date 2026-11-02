import { EventHandler } from './eventHandler'
import { createEvents } from './events'
import { History } from './history'
import { InitialVisit } from './initialVisit'
import { CurrentPage } from './page'
import { Polls } from './polls'
import { PrefetchedRequests } from './prefetched'
import Queue from './queue'
import { Router } from './router'
import { Scroll } from './scroll'
import type { ExternalNavigationOptions, VisitCallbacks } from './types'

export class RouterContext {
  public readonly navigation: { external?: ExternalNavigationOptions; active: boolean } = { active: true }
  public dispose: VoidFunction = () => {
    this.navigation.active = false
  }
  public readonly events = createEvents(this)
  public readonly history = new History(this)
  public readonly page = new CurrentPage(this)
  public readonly prefetchedRequests = new PrefetchedRequests(this)
  public readonly eventHandler = new EventHandler(this)
  public readonly polls = new Polls(this)
  public readonly scroll = new Scroll(this)
  public readonly initialVisit = new InitialVisit(this)
  public readonly responseQueue = new Queue<Promise<boolean | void>>()
  public readonly clientVisitQueue = new Queue<Promise<void>>()
  public readonly infiniteScrollQueue = new Queue<Promise<void>>()
  public infiniteScrollInitialUrl: URL | null = null
  public infiniteScrollPayloadUrl: URL | null = null
  public infiniteScrollInitialUrlWasAbsolute: boolean | null = null
  public readonly router = new Router(this)

  public callback<Callback extends (...args: any[]) => any>(
    callback: Callback,
  ): (...args: Parameters<Callback>) => ReturnType<Callback> | undefined {
    return (...args) => {
      if (this.navigation.active) {
        return callback(...args)
      }
    }
  }

  public visitCallbacks(callbacks: VisitCallbacks): VisitCallbacks {
    return {
      ...callbacks,
      onBefore: (...args) => (this.navigation.active ? callbacks.onBefore(...args) : false),
      onBeforeUpdate: this.callback(callbacks.onBeforeUpdate),
      onCancelToken: this.callback(callbacks.onCancelToken),
      onStart: this.callback(callbacks.onStart),
      onProgress: this.callback(callbacks.onProgress),
      onSuccess: this.callback(callbacks.onSuccess),
      onError: this.callback(callbacks.onError),
      onHttpException: (...args) => (this.navigation.active ? callbacks.onHttpException(...args) : false),
      onNetworkError: (...args) => (this.navigation.active ? callbacks.onNetworkError(...args) : false),
      onFlash: this.callback(callbacks.onFlash),
      onPrefetched: this.callback(callbacks.onPrefetched),
      onPrefetching: this.callback(callbacks.onPrefetching),
    }
  }
}
