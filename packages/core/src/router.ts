import { cloneDeep, isEqual } from 'es-toolkit'
import { get, set } from 'es-toolkit/compat'
import { config } from './config'
import { setPathPreservingIdentity, stripTopLevelUndefined } from './objectUtils'
import { progress } from './progress'
import { Request } from './request'
import { RequestParams } from './requestParams'
import { RequestStream } from './requestStream'
import type { RouterContext } from './routerContext'
import {
  ActiveVisit,
  ClientSideVisitOptions,
  Component,
  FlashData,
  GlobalEvent,
  GlobalEventNames,
  GlobalEventResult,
  InFlightPrefetch,
  Method,
  OptimisticCallback,
  Page,
  PageFlashData,
  PageProps,
  PendingVisit,
  PollOptions,
  PrefetchedResponse,
  PrefetchOptions,
  ReloadOptions,
  RequestPayload,
  RouterInitParams,
  UrlMethodPair,
  Visit,
  VisitCallbacks,
  VisitHelperOptions,
  VisitOptions,
} from './types'
import { uid } from './uid'
import {
  hrefToUrl,
  isSameUrlWithoutHash,
  isSameUrlWithoutQueryOrHash,
  isUrlMethodPair,
  transformUrlAndData,
} from './url'

const noop = () => {}

export class Router {
  constructor(protected context: RouterContext) {}

  protected syncRequestStream = new RequestStream({
    maxConcurrent: 1,
    interruptible: true,
  })

  protected asyncRequestStream = new RequestStream({
    maxConcurrent: Infinity,
    interruptible: false,
  })

  protected pendingOptimisticCallback: OptimisticCallback | undefined = undefined

  public init<ComponentType = Component>({
    initialPage,
    resolveComponent,
    swapComponent,
    onFlash,
    externalNavigation,
  }: RouterInitParams<ComponentType>): VoidFunction {
    this.context.navigation.external = externalNavigation

    if (externalNavigation) {
      this.context.history.reset()
    } else if (typeof window !== 'undefined') {
      window.history.scrollRestoration = 'manual'
    }

    this.context.page.init({
      initialPage,
      resolveComponent,
      swapComponent,
      onFlash,
    })

    const disposeEvents = this.context.eventHandler.init(!!externalNavigation)
    const disposePolls = this.context.polls.init()

    const removeMissingHistoryItemListener = this.context.eventHandler.on('missingHistoryItem', () => {
      if (typeof window !== 'undefined') {
        this.visit(window.location.href, {
          preserveState: true,
          preserveScroll: true,
          replace: true,
        })
      }
    })

    const removeLoadDeferredPropsListener = this.context.eventHandler.on(
      'loadDeferredProps',
      (deferredProps: Page['deferredProps']) => {
        this.loadDeferredProps(deferredProps)
      },
    )

    const removeHistoryQuotaExceededListener = this.context.eventHandler.on('historyQuotaExceeded', (url) => {
      window.location.href = url
    })

    const dispose = (this.context.dispose = () => {
      if (!this.context.navigation.active) {
        return
      }

      this.context.navigation.active = false
      this.pendingOptimisticCallback = undefined
      this.context.polls.clear()
      disposePolls()
      this.context.prefetchedRequests.dispose()
      this.context.page.destroy()
      disposeEvents()
      removeMissingHistoryItemListener()
      removeLoadDeferredPropsListener()
      removeHistoryQuotaExceededListener()
      try {
        this.asyncRequestStream.cancelInFlight()
      } finally {
        this.syncRequestStream.cancelInFlight()
      }
    })

    try {
      this.context.initialVisit.handle()
    } catch (exception) {
      dispose()

      throw exception
    }

    return dispose
  }

  public optimistic<TProps>(callback: OptimisticCallback<TProps>): this {
    this.pendingOptimisticCallback = callback as OptimisticCallback

    return this
  }

  public get<T extends RequestPayload = RequestPayload>(
    url: URL | string | UrlMethodPair,
    data: T = {} as T,
    options: VisitHelperOptions<T> = {},
  ): void {
    return this.visit(url, { ...options, method: 'get', data })
  }

  public post<T extends RequestPayload = RequestPayload>(
    url: URL | string | UrlMethodPair,
    data: T = {} as T,
    options: VisitHelperOptions<T> = {},
  ): void {
    return this.visit(url, {
      preserveState: true,
      ...options,
      method: 'post',
      data,
    })
  }

  public put<T extends RequestPayload = RequestPayload>(
    url: URL | string | UrlMethodPair,
    data: T = {} as T,
    options: VisitHelperOptions<T> = {},
  ): void {
    return this.visit(url, {
      preserveState: true,
      ...options,
      method: 'put',
      data,
    })
  }

  public patch<T extends RequestPayload = RequestPayload>(
    url: URL | string | UrlMethodPair,
    data: T = {} as T,
    options: VisitHelperOptions<T> = {},
  ): void {
    return this.visit(url, {
      preserveState: true,
      ...options,
      method: 'patch',
      data,
    })
  }

  public delete<T extends RequestPayload = RequestPayload>(
    url: URL | string | UrlMethodPair,
    options: Omit<VisitOptions<T>, 'method'> = {},
  ): void {
    return this.visit(url, {
      preserveState: true,
      ...options,
      method: 'delete',
    })
  }

  public reload<T extends RequestPayload = RequestPayload>(options: ReloadOptions<T> = {}): void {
    return this.doReload(options)
  }

  protected doReload<T extends RequestPayload = RequestPayload>(
    options: ReloadOptions<T> & {
      deferredProps?: boolean
      poll?: boolean
    } = {},
  ): void {
    if (typeof window === 'undefined') {
      return
    }

    return this.visit(this.context.navigation.external ? this.context.page.get().url : window.location.href, {
      ...options,
      preserveScroll: true,
      preserveState: true,
      async: true,
      headers: {
        ...(options.headers || {}),
        'Cache-Control': 'no-cache',
      },
    })
  }

  public remember(data: unknown, key = 'default'): void {
    this.context.history.remember(data, key)
  }

  public restore<T = unknown>(key = 'default'): T | undefined {
    return this.context.history.restore(key) as T | undefined
  }

  public on<TEventName extends GlobalEventNames>(
    type: TEventName,
    callback: (event: GlobalEvent<TEventName>) => GlobalEventResult<TEventName>,
  ): VoidFunction {
    if (typeof window === 'undefined') {
      return () => {}
    }

    return this.context.eventHandler.onGlobalEvent(type, callback)
  }

  public once<TEventName extends GlobalEventNames>(
    type: TEventName,
    callback: (event: GlobalEvent<TEventName>) => GlobalEventResult<TEventName>,
  ): VoidFunction {
    if (typeof window === 'undefined') {
      return () => {}
    }

    const remove = this.on(type, (event) => {
      remove()
      return callback(event)
    })

    return remove
  }

  public hasPendingOptimistic(): boolean {
    return this.asyncRequestStream.hasPendingOptimistic()
  }

  public get activePolls(): number {
    return this.context.polls.count
  }

  public cancelAll({ async = true, prefetch = true, sync = true } = {}): void {
    const syncRequestStream = this.syncRequestStream
    const asyncRequestStream = this.asyncRequestStream

    if (async) {
      asyncRequestStream.cancelInFlight({ prefetch })
    }

    if (sync) {
      syncRequestStream.cancelInFlight()
    }
  }

  public poll(interval: number, requestOptions: ReloadOptions | (() => ReloadOptions) = {}, options: PollOptions = {}) {
    return this.context.polls.add(
      interval,
      ({ onStart, onFinish }) => {
        const resolved = typeof requestOptions === 'function' ? requestOptions() : requestOptions

        this.doReload({
          poll: true,
          preserveErrors: true,
          ...resolved,
          onCancelToken: (token) => {
            onStart(token.cancel)
            resolved.onCancelToken?.(token)
          },
          onFinish: (visit) => {
            onFinish()
            resolved.onFinish?.(visit)
          },
        })
      },
      {
        autoStart: options.autoStart ?? true,
        keepAlive: options.keepAlive ?? false,
        mode: options.mode,
      },
    )
  }

  public visit<T extends RequestPayload = RequestPayload>(
    href: string | URL | UrlMethodPair,
    options: VisitOptions<T> = {},
  ): void {
    if (!this.context.navigation.active) {
      return
    }

    options.optimistic = options.optimistic ?? this.pendingOptimisticCallback
    this.pendingOptimisticCallback = undefined

    if (options.optimistic) {
      options.async = options.async ?? true
    }

    const visit: PendingVisit = this.getPendingVisit(href, {
      ...options,
      showProgress: options.showProgress ?? (!options.async || !!options.optimistic),
    } as VisitOptions)

    const events = this.getVisitEvents(options as VisitOptions)

    // If either of these return false, we don't want to continue
    if (events.onBefore(visit) === false || !this.context.events.fireBeforeEvent(visit)) {
      return
    }

    if (
      this.context.navigation.external &&
      visit.method === 'get' &&
      !visit.async &&
      !visit.only.length &&
      !visit.except.length &&
      !visit.reset.length
    ) {
      this.context.navigation.external.navigate(visit.url.href)

      return
    }

    const currentPageUrl = hrefToUrl(this.context.page.get().url)
    const isPartialReload = visit.only.length > 0 || visit.except.length > 0 || visit.reset.length > 0

    // For partial reloads, only compare the base URL (origin + pathname) to allow
    // concurrent requests with different query params to the same page
    const isSamePage = isPartialReload
      ? isSameUrlWithoutQueryOrHash(visit.url, currentPageUrl)
      : isSameUrlWithoutHash(visit.url, currentPageUrl)

    if (!isSamePage) {
      // Cancel in-flight requests aimed at the page we're navigating away from
      // (deferred props, partial reloads, plain reloads), but leave prefetches,
      // optimistic requests, and background async visits to other pages untouched
      this.asyncRequestStream.cancelInFlight(
        (request) =>
          !request.isPrefetch() &&
          !request.isOptimistic() &&
          isSameUrlWithoutQueryOrHash(request.getUrl(), currentPageUrl),
      )
    }

    // Interrupt in-flight requests before taking the optimistic snapshot
    // so that any previous optimistic state is restored first
    if (!visit.async) {
      this.syncRequestStream.interruptInFlight()
    }

    let optimisticId: number | null = null

    if (options.optimistic) {
      optimisticId = this.context.page.nextOptimisticId()

      this.applyOptimisticUpdate(options.optimistic, events, optimisticId)
    }

    if (!this.context.page.isCleared() && !visit.preserveUrl) {
      // Save scroll regions for the current page
      this.context.scroll.save()
    }

    const requestParams: PendingVisit & VisitCallbacks = {
      ...visit,
      ...events,
    }

    const sendRequest = () => {
      if (!this.context.navigation.active) {
        return
      }

      const prefetched = this.context.prefetchedRequests.get(requestParams)

      if (prefetched) {
        progress.reveal(prefetched.inFlight)
        this.context.prefetchedRequests.use(prefetched, requestParams)
      } else {
        progress.reveal(true)
        const requestStream = visit.async ? this.asyncRequestStream : this.syncRequestStream
        requestStream.send(
          Request.create(this.context, requestParams, this.context.page.get(), {
            optimisticId,
          }),
        )
      }
    }

    if (Array.isArray(visit.component)) {
      console.error(
        `The "component" prop received an array of components (${visit.component.join(', ')}), but only a single component string is supported for instant visits. Pass an explicit component name instead.`,
      )
      visit.component = null
    }

    if (visit.component && !this.context.navigation.external) {
      this.context.history.processQueue().then(() => {
        if (!this.context.navigation.active) {
          return
        }

        this.performInstantSwap(visit).then(() => {
          requestParams.preserveScroll = true
          requestParams.preserveState = true
          requestParams.replace = true
          requestParams.viewTransition = false
          sendRequest()
        })
      })
    } else {
      sendRequest()
    }
  }

  public getCached(
    href: string | URL | UrlMethodPair,
    options: VisitOptions = {},
  ): InFlightPrefetch | PrefetchedResponse | null {
    return this.context.prefetchedRequests.findCached(this.getPrefetchParams(href, options))
  }

  public flush(href: string | URL | UrlMethodPair, options: VisitOptions = {}): void {
    this.context.prefetchedRequests.remove(this.getPrefetchParams(href, options))
  }

  public flushAll(): void {
    this.context.prefetchedRequests.removeAll()
  }

  public flushByCacheTags(tags: string | string[]): void {
    this.context.prefetchedRequests.removeByTags(Array.isArray(tags) ? tags : [tags])
  }

  public getPrefetching(
    href: string | URL | UrlMethodPair,
    options: VisitOptions = {},
  ): InFlightPrefetch | PrefetchedResponse | null {
    return this.context.prefetchedRequests.findInFlight(this.getPrefetchParams(href, options))
  }

  public prefetch(
    href: string | URL | UrlMethodPair,
    options: VisitOptions = {},
    prefetchOptions: Partial<PrefetchOptions> = {},
  ) {
    const method: Method = options.method ?? (isUrlMethodPair(href) ? href.method : 'get')

    if (method !== 'get') {
      throw new Error('Prefetch requests must use the GET method')
    }

    const visit: PendingVisit = this.getPendingVisit(href, {
      ...options,
      async: true,
      showProgress: false,
      prefetch: true,
      viewTransition: false,
    })

    const visitUrl = visit.url.origin + visit.url.pathname + visit.url.search
    const currentUrl = window.location.origin + window.location.pathname + window.location.search

    if (visitUrl === currentUrl) {
      // Don't prefetch the current page, you're already on it
      return
    }

    const events = this.getVisitEvents(options)

    // If either of these return false, we don't want to continue
    if (events.onBefore(visit) === false || !this.context.events.fireBeforeEvent(visit)) {
      return
    }

    progress.hide()

    this.asyncRequestStream.interruptInFlight()

    const requestParams: PendingVisit & VisitCallbacks = {
      ...visit,
      ...events,
    }

    const ensureCurrentPageIsSet = (): Promise<void> => {
      return new Promise((resolve) => {
        const checkIfPageIsDefined = () => {
          if (!this.context.navigation.active || this.context.page.get()) {
            resolve()
          } else {
            setTimeout(checkIfPageIsDefined, 50)
          }
        }

        checkIfPageIsDefined()
      })
    }

    ensureCurrentPageIsSet().then(() => {
      if (!this.context.navigation.active) {
        return
      }

      this.context.prefetchedRequests.add(
        requestParams,
        (params) => {
          this.asyncRequestStream.send(Request.create(this.context, params, this.context.page.get()))
        },
        {
          cacheFor: config.get('prefetch.cacheFor'),
          cacheTags: [],
          ...prefetchOptions,
        },
      )
    })
  }

  public clearHistory(): void {
    this.context.history.clear()
  }

  public decryptHistory(): Promise<Page> {
    return this.context.history.decrypt()
  }

  public resolveComponent(component: string, page?: Page): Promise<Component> {
    return this.context.page.resolve(component, page)
  }

  public replace<TProps = Page['props']>(params: ClientSideVisitOptions<TProps>): void {
    this.clientVisit(params, { replace: true })
  }

  public replaceProp<TProps = Page['props']>(
    name: string,
    value: unknown | ((oldValue: unknown, props: TProps) => unknown),
    options?: Pick<ClientSideVisitOptions, 'onError' | 'onFinish' | 'onSuccess'>,
  ): void {
    this.replace({
      preserveScroll: true,
      preserveState: true,
      props(currentProps) {
        const newValue = typeof value === 'function' ? value(get(currentProps, name), currentProps) : value

        return setPathPreservingIdentity(currentProps, name, newValue)
      },
      ...(options || {}),
    })
  }

  public appendToProp<TProps = Page['props']>(
    name: string,
    value: unknown | unknown[] | ((oldValue: unknown, props: TProps) => unknown | unknown[]),
    options?: Pick<ClientSideVisitOptions, 'onError' | 'onFinish' | 'onSuccess'>,
  ): void {
    this.replaceProp(
      name,
      (currentValue: unknown, currentProps: TProps) => {
        const newValue = typeof value === 'function' ? value(currentValue, currentProps) : value

        if (!Array.isArray(currentValue)) {
          currentValue = currentValue !== undefined ? [currentValue] : []
        }

        return [...(currentValue as unknown[]), newValue]
      },
      options,
    )
  }

  public prependToProp<TProps = Page['props']>(
    name: string,
    value: unknown | unknown[] | ((oldValue: unknown, props: TProps) => unknown | unknown[]),
    options?: Pick<ClientSideVisitOptions, 'onError' | 'onFinish' | 'onSuccess'>,
  ): void {
    this.replaceProp(
      name,
      (currentValue: unknown, currentProps: TProps) => {
        const newValue = typeof value === 'function' ? value(currentValue, currentProps) : value

        if (!Array.isArray(currentValue)) {
          currentValue = currentValue !== undefined ? [currentValue] : []
        }

        return [newValue, ...(currentValue as unknown[])]
      },
      options,
    )
  }

  public push<TProps = Page['props']>(params: ClientSideVisitOptions<TProps>): void {
    this.clientVisit(params)
  }

  public flash<TFlash extends PageFlashData = PageFlashData>(
    keyOrData: string | ((flash: FlashData) => TFlash) | TFlash,
    value?: unknown,
  ): void {
    if (!this.context.navigation.active) {
      return
    }

    const current = this.context.page.get().flash
    let flash: PageFlashData

    if (typeof keyOrData === 'function') {
      flash = keyOrData(current)
    } else if (typeof keyOrData === 'string') {
      flash = { ...current, [keyOrData]: value }
    } else if (keyOrData && Object.keys(keyOrData).length) {
      flash = { ...current, ...keyOrData }
    } else {
      return
    }

    this.context.page.setFlash(flash)

    if (Object.keys(flash).length) {
      this.context.events.fireFlashEvent(flash)
    }
  }

  protected clientVisit<TProps = Page['props']>(
    params: ClientSideVisitOptions<TProps>,
    { replace = false }: { replace?: boolean } = {},
  ): void {
    this.context.clientVisitQueue.add(() => {
      if (!this.context.navigation.active) {
        return Promise.resolve()
      }

      const current = this.context.page.get()

      if (
        this.context.navigation.external &&
        ((params.url && hrefToUrl(params.url).href !== hrefToUrl(current.url).href) ||
          (params.component && params.component !== current.component))
      ) {
        this.context.navigation.external.navigate(hrefToUrl(params.url || current.url).href)

        return Promise.resolve()
      }

      return this.performClientVisit(params, { replace })
    })
  }

  protected performClientVisit<TProps = Page['props']>(
    params: ClientSideVisitOptions<TProps>,
    { replace = false }: { replace?: boolean } = {},
  ): Promise<void> {
    const current = this.context.page.get()

    const onceProps =
      typeof params.props === 'function'
        ? Object.fromEntries(
            Object.values(current.onceProps ?? {}).map((onceProp) => [
              onceProp.prop,
              get(current.props, onceProp.prop),
            ]),
          )
        : {}

    const props =
      typeof params.props === 'function'
        ? params.props(current.props as TProps, onceProps as Partial<TProps>)
        : (params.props ?? current.props)

    if (!this.context.navigation.active) {
      return Promise.resolve()
    }

    const flash = typeof params.flash === 'function' ? params.flash(current.flash) : params.flash

    if (!this.context.navigation.active) {
      return Promise.resolve()
    }

    const { viewTransition, onError, onFinish, onFlash, onSuccess, ...pageParams } = params

    const page = {
      ...current,
      ...pageParams,
      flash: flash ?? {},
      props: props as Page['props'],
    }

    const preserveScroll = RequestParams.resolvePreserveOption(params.preserveScroll ?? false, page)

    if (!this.context.navigation.active) {
      return Promise.resolve()
    }

    const preserveState = RequestParams.resolvePreserveOption(params.preserveState ?? false, page)

    const visitId = this.createVisitId()

    return this.context.page
      .set(page, {
        replace,
        preserveScroll,
        preserveState,
        viewTransition,
        visitId,
      })
      .then(() => {
        this.context.events.fireClientVisitEvent(this.context.page.get(), {
          replace,
          visitId,
        })

        const currentFlash = this.context.page.get().flash

        if (Object.keys(currentFlash).length > 0) {
          this.context.events.fireFlashEvent(currentFlash)

          this.context.callback(onFlash || noop)(currentFlash)
        }

        const errors = this.context.page.get().props.errors || {}

        if (Object.keys(errors).length === 0) {
          this.context.callback(onSuccess || noop)(this.context.page.get())
          return
        }

        const scopedErrors = params.errorBag ? errors[params.errorBag || ''] || {} : errors

        this.context.callback(onError || noop)(scopedErrors)
      })
      .finally(() => onFinish?.(params))
  }

  protected performInstantSwap(visit: PendingVisit): Promise<void> {
    const current = this.context.page.get()

    const sharedProps = Object.fromEntries(
      (current.sharedProps ?? []).filter((key) => key in current.props).map((key) => [key, current.props[key]]),
    )

    const resolvedPageProps =
      typeof visit.pageProps === 'function'
        ? visit.pageProps(cloneDeep(current.props), cloneDeep(sharedProps))
        : visit.pageProps

    const intermediateProps = resolvedPageProps !== null ? { ...resolvedPageProps } : { ...sharedProps }

    const onceProps = this.preserveOncePropsOnInstantVisit(current, intermediateProps)

    const intermediatePage: Page = {
      component: visit.component!,
      url: visit.url.pathname + visit.url.search + visit.url.hash,
      version: current.version,
      props: {
        ...intermediateProps,
        errors: {},
      },
      flash: {},
      rescuedProps: [],
      clearHistory: false,
      encryptHistory: current.encryptHistory,
      sharedProps: current.sharedProps,
      onceProps,
      rememberedState: {},
    }

    return this.context.page.set(intermediatePage, {
      replace: visit.replace,
      preserveScroll: RequestParams.resolvePreserveOption(visit.preserveScroll, intermediatePage),
      preserveState: false,
      viewTransition: visit.viewTransition,
      visitId: visit.id,
    })
  }

  /**
   * Once props are remembered client-side, so the placeholder page must preserve their values
   * and registry. Otherwise the swap discards the value, and an in-flight prefetch that already
   * claimed the prop resolves with nothing to restore it from.
   */
  protected preserveOncePropsOnInstantVisit(current: Page, props: PageProps): Page['onceProps'] {
    const onceProps: NonNullable<Page['onceProps']> = {}

    Object.entries(current.onceProps ?? {}).forEach(([key, onceProp]) => {
      if (get(props, onceProp.prop) !== undefined) {
        // The visit provided its own value, so we can't claim to remember the once prop
        return
      }

      const currentValue = get(current.props, onceProp.prop)

      if (currentValue === undefined) {
        return
      }

      set(props, onceProp.prop, currentValue)

      onceProps[key] = onceProp
    })

    return onceProps
  }

  protected getPrefetchParams(href: string | URL | UrlMethodPair, options: VisitOptions): ActiveVisit {
    return {
      ...this.getPendingVisit(href, {
        ...options,
        async: true,
        showProgress: false,
        prefetch: true,
        viewTransition: false,
      }),
      ...this.getVisitEvents(options),
    }
  }

  protected createVisitId(): string {
    return uid()
  }

  protected getPendingVisit(href: string | URL | UrlMethodPair, options: VisitOptions): PendingVisit {
    if (isUrlMethodPair(href)) {
      const urlMethodPair = href
      href = urlMethodPair.url
      options.method = options.method ?? urlMethodPair.method
    }

    const defaultVisitOptionsCallback = config.get('visitOptions')

    const configuredOptions = defaultVisitOptionsCallback
      ? defaultVisitOptionsCallback(href.toString(), cloneDeep(options)) || {}
      : {}

    const mergedOptions: Visit = {
      method: 'get',
      data: {},
      replace: false,
      preserveScroll: false,
      preserveState: false,
      only: [],
      except: [],
      headers: {},
      errorBag: '',
      forceFormData: false,
      queryStringArrayFormat: 'brackets',
      async: false,
      showProgress: true,
      fresh: false,
      reset: [],
      preserveUrl: false,
      preserveErrors: false,
      prefetch: false,
      invalidateCacheTags: [],
      viewTransition: false,
      component: null,
      pageProps: null,
      cached: false,
      ...stripTopLevelUndefined(options),
      ...stripTopLevelUndefined(configuredOptions),
    }

    const [url, _data] = transformUrlAndData(
      href,
      mergedOptions.data,
      mergedOptions.method,
      mergedOptions.forceFormData,
      mergedOptions.queryStringArrayFormat,
    )

    const visit = {
      id: this.createVisitId(),
      cancelled: false,
      completed: false,
      interrupted: false,
      ...mergedOptions,
      url,
      data: _data,
    }

    if (visit.prefetch) {
      visit.headers['Purpose'] = 'prefetch'
    }

    return visit
  }

  protected getVisitEvents(options: VisitOptions): VisitCallbacks {
    return this.context.visitCallbacks({
      onCancelToken: options.onCancelToken || noop,
      onBefore: options.onBefore || noop,
      onBeforeUpdate: options.onBeforeUpdate || noop,
      onStart: options.onStart || noop,
      onProgress: options.onProgress || noop,
      onFinish: options.onFinish || noop,
      onCancel: options.onCancel || noop,
      onSuccess: options.onSuccess || noop,
      onError: options.onError || noop,
      onHttpException: options.onHttpException || noop,
      onNetworkError: options.onNetworkError || noop,
      onFlash: options.onFlash || noop,
      onPrefetched: options.onPrefetched || noop,
      onPrefetching: options.onPrefetching || noop,
    })
  }

  protected applyOptimisticUpdate(optimistic: OptimisticCallback, events: VisitCallbacks, id: number): void {
    if (!this.context.navigation.active) {
      return
    }

    const currentProps = this.context.page.get().props
    const optimisticProps = optimistic(cloneDeep(currentProps))

    if (!optimisticProps) {
      return
    }

    const changedKeys: string[] = []

    for (const key of Object.keys(optimisticProps)) {
      if (!isEqual(currentProps[key], optimisticProps[key])) {
        changedKeys.push(key)
      }
    }

    if (changedKeys.length === 0) {
      return
    }

    const component = this.context.page.get().component

    for (const key of changedKeys) {
      this.context.page.setBaseline(key, cloneDeep(currentProps[key]))
    }

    this.context.page.registerOptimistic(id, optimistic)
    this.context.page.setPropsQuietly({ ...currentProps, ...optimisticProps })

    let shouldRestore = true

    const originalOnSuccess = events.onSuccess
    events.onSuccess = (page) => {
      shouldRestore = false
      this.context.page.markOptimisticConfirmed(id)

      return originalOnSuccess(page)
    }

    const originalOnFinish = events.onFinish
    events.onFinish = (visit) => {
      if (!this.context.navigation.active) {
        return originalOnFinish(visit)
      }

      this.context.page.unregisterOptimistic(id)

      if (shouldRestore && this.context.page.get().component === component) {
        const replayedProps = this.context.page.replayOptimistics()

        if (Object.keys(replayedProps).length > 0) {
          this.context.page.setPropsQuietly({
            ...this.context.page.get().props,
            ...replayedProps,
          })
        }
      }

      if (this.context.page.pendingOptimisticCount() === 0) {
        this.context.page.clearOptimisticState()
      }

      return originalOnFinish(visit)
    }
  }

  protected loadDeferredProps(deferred: Page['deferredProps']): void {
    if (deferred) {
      for (const props of Object.values(deferred)) {
        this.doReload({
          only: props,
          deferredProps: true,
          preserveErrors: true,
        })
      }
    }
  }
}
