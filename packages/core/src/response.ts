import { isEqual } from 'es-toolkit'
import { get, set } from 'es-toolkit/compat'
import dialog from './dialog'
import { isFormData } from './formData'
import { interceptors } from './interceptors'
import { parsePage } from './json'
import { partialReloadRequestsProp } from './partialReload'
import { RequestParams } from './requestParams'
import type { RouterContext } from './routerContext'
import { SessionStorage } from './sessionStorage'
import { ActiveVisit, ErrorBag, Errors, HttpResponse, Page, PageProps } from './types'
import { hrefToUrl, isSameUrlWithoutHash, isSameUrlWithoutQueryOrHash, setHashIfSameUrl } from './url'

export class Response {
  protected wasPrefetched = false
  protected processed = false
  protected pageApplied = false

  constructor(
    protected context: RouterContext,
    protected requestParams: RequestParams,
    protected response: HttpResponse,
    protected originatingPage: Page,
    protected optimisticId: number | null = null,
  ) {}

  public static create(
    context: RouterContext,
    params: RequestParams,
    response: HttpResponse,
    originatingPage: Page,
    optimisticId: number | null = null,
  ): Response {
    return new Response(context, params, response, originatingPage, optimisticId)
  }

  public isProcessed(): boolean {
    return this.processed
  }

  public async handlePrefetch() {
    const { method, url } = this.requestParams.all()

    // A QUERY prefetch may carry a different body than the current page, so it's only used once visited
    if (method !== 'query' && isSameUrlWithoutHash(url, window.location)) {
      this.handle()
    }
  }

  public async handle() {
    return this.context.responseQueue.add(() => this.process())
  }

  public async process() {
    if (!this.context.navigation.active) {
      return
    }

    // A cached response is processed again for every visit that uses it
    this.pageApplied = false

    if (this.requestParams.all().prefetch) {
      this.wasPrefetched = true
      this.requestParams.all().prefetch = false

      this.requestParams.all().onPrefetched(this.response, this.requestParams.all())

      this.context.events.firePrefetchedEvent(this.response, this.requestParams.all())

      return Promise.resolve()
    }

    this.requestParams.runCallbacks()
    this.processed = true

    if (this.requestParams.wasCancelledAtAll()) {
      return
    }

    if (!this.isInertiaResponse()) {
      return this.handleNonInertiaResponse()
    }

    if (this.isHttpException()) {
      const response = {
        ...this.response,
        data: this.getDataFromResponse(this.response.data),
      }

      if (this.requestParams.all().onHttpException(response) === false) {
        return
      }

      if (!this.context.events.fireHttpExceptionEvent(response)) {
        return
      }
    }

    await this.context.history.processQueue()

    if (this.context.navigation.external) {
      if (!this.shouldSetPage(this.getPageResponse())) {
        return
      }

      this.response = await interceptors.processResponse(this.context, this.requestParams.all(), this.response)

      const destination = this.getPageResponse()
      const sameComponent = destination.component === this.context.page.get().component
      const destinationUrl = new URL(this.pageUrl(destination), hrefToUrl(destination.url))
      const currentUrl = hrefToUrl(this.context.page.get().url)
      const sameUrl = destinationUrl.href === currentUrl.href
      const queryOnlyPartialReload =
        this.requestParams.all().method === 'get' &&
        this.requestParams.isPartial() &&
        destinationUrl.hash === currentUrl.hash &&
        isSameUrlWithoutQueryOrHash(destinationUrl, currentUrl)

      if (!sameComponent || (!sameUrl && !queryOnlyPartialReload)) {
        destination.url = destinationUrl.href

        return this.handleExternalNavigation(destination)
      }
    }

    this.context.history.preserveUrl = this.requestParams.all().preserveUrl

    try {
      await this.setPage()

      // A visit that's cancelled before its page is applied reports nothing, but once the page is shown it still does
      if (this.requestParams.wasCancelledAtAll() && !this.pageApplied) {
        return
      }

      const { flash } = this.context.page.get()

      if (Object.keys(flash).length > 0 && !this.requestParams.isDeferredPropsRequest()) {
        this.context.events.fireFlashEvent(flash)
        this.requestParams.all().onFlash(flash)
      }

      const errors = this.context.page.get().props.errors || {}

      if (Object.keys(errors).length > 0) {
        const scopedErrors = this.getScopedErrors(errors)

        this.context.events.fireErrorEvent(scopedErrors, {
          page: this.context.page.get(),
          visitId: this.requestParams.all().id,
        })

        return this.requestParams.all().onError(scopedErrors)
      }

      this.context.router.flushByCacheTags(this.requestParams.all().invalidateCacheTags || [])

      if (!this.wasPrefetched) {
        // We end up here other than from the prefetch cache, so we assume this response is
        // newer than the cached one and therefore flush the cache.
        this.context.router.flush(this.context.page.get().url)
      }

      this.context.events.fireSuccessEvent(this.context.page.get(), {
        visitId: this.requestParams.all().id,
      })

      await this.requestParams.all().onSuccess(this.context.page.get())
    } finally {
      this.context.history.preserveUrl = false
    }
  }

  protected async handleExternalNavigation(destination: Page): Promise<void> {
    if (Object.keys(destination.flash).length > 0 && !this.requestParams.isDeferredPropsRequest()) {
      this.context.events.fireFlashEvent(destination.flash)
      this.requestParams.all().onFlash(destination.flash)
    }

    const errors = destination.props.errors || {}

    if (Object.keys(errors).length > 0) {
      const scopedErrors = this.getScopedErrors(errors)

      this.context.events.fireErrorEvent(scopedErrors, {
        page: destination,
        visitId: this.requestParams.all().id,
      })

      await this.requestParams.all().onError(scopedErrors)
    } else {
      this.context.router.flushByCacheTags(this.requestParams.all().invalidateCacheTags || [])

      if (!this.wasPrefetched) {
        this.context.router.flush(destination.url)
      }

      this.context.events.fireSuccessEvent(destination, {
        visitId: this.requestParams.all().id,
      })

      await this.requestParams.all().onSuccess(destination)
    }

    if (this.context.navigation.active) {
      this.requestParams.markAsFinished()
      this.context.navigation.external?.navigate(destination.url)
    }
  }

  public mergeParams(params: ActiveVisit) {
    this.requestParams.merge(params)
  }

  public interrupt(): void {
    if (!this.requestParams.wasCancelledAtAll()) {
      this.requestParams.markAsCancelled({ cancelled: false, interrupted: true })
    }
  }

  public getPageResponse(): Page {
    const data = this.getDataFromResponse(this.response.data)

    // Only spread if data is an object (not a string like HTML error pages)
    if (typeof data === 'object') {
      return (this.response.data = {
        ...data,
        flash: data.flash ?? {},
        rescuedProps: data.rescuedProps ?? [],
      })
    }

    return (this.response.data = data)
  }

  protected async handleNonInertiaResponse() {
    if (this.isInertiaRedirect()) {
      this.context.router.visit(this.getHeader('x-inertia-redirect'), {
        ...this.requestParams.all(),
        method: 'get',
        data: {},
      })

      return
    }

    if (this.isLocationVisit()) {
      const locationUrl = hrefToUrl(this.getHeader('x-inertia-location'))

      setHashIfSameUrl(this.requestParams.all().url, locationUrl)

      return this.locationVisit(locationUrl)
    }

    const response = {
      ...this.response,
      data: this.getDataFromResponse(this.response.data),
    }

    if (this.requestParams.all().onHttpException(response) === false) {
      return
    }

    if (this.context.events.fireHttpExceptionEvent(response)) {
      return dialog.show(response.data)
    }
  }

  protected isInertiaResponse(): boolean {
    return this.hasHeader('x-inertia')
  }

  protected isHttpException(): boolean {
    return this.response.status >= 400
  }

  protected hasStatus(status: number): boolean {
    return this.response.status === status
  }

  protected getHeader(header: string): string {
    return this.response.headers[header]
  }

  protected hasHeader(header: string): boolean {
    return this.getHeader(header) !== undefined
  }

  protected isInertiaRedirect(): boolean {
    return this.hasStatus(409) && this.hasHeader('x-inertia-redirect')
  }

  protected isLocationVisit(): boolean {
    return this.hasStatus(409) && this.hasHeader('x-inertia-location')
  }

  /**
   * @link https://inertiajs.com/redirects#external-redirects
   */
  protected locationVisit(url: URL): boolean | void {
    try {
      if (typeof window === 'undefined') {
        return
      }

      const responseVersion = this.getHeader('x-inertia-version')
      const versionChange = !!responseVersion && responseVersion !== this.context.page.get().version

      if (!this.context.events.fireLocationEvent(url, versionChange)) {
        return
      }

      // A version change on a background request only needs to pick up new assets, so we don't
      // force a full-page navigation the user never initiated. The next user-initiated visit
      // hits the same location response and reloads then.
      if (versionChange && this.requestParams.all().async) {
        return
      }

      if (this.context.navigation.external && !versionChange) {
        this.requestParams.markAsFinished()
        this.context.navigation.external.navigate(url.href)

        return
      }

      SessionStorage.set(SessionStorage.locationVisitKey, {
        preserveScroll: this.requestParams.all().preserveScroll === true,
      })

      if (isSameUrlWithoutHash(window.location, url)) {
        window.location.reload()
      } else {
        window.location.href = url.href
      }
    } catch (error) {
      return false
    }
  }

  protected async setPage(): Promise<void> {
    const pageResponse = this.getPageResponse()

    if (!this.shouldSetPage(pageResponse)) {
      return Promise.resolve()
    }

    if (!this.context.navigation.external) {
      this.response = await interceptors.processResponse(this.context, this.requestParams.all(), this.response)
    }

    this.mergeProps(pageResponse)
    this.context.page.mergeOncePropsIntoResponse(pageResponse)
    this.preserveOptimisticProps(pageResponse)
    this.preserveEqualProps(pageResponse)

    await this.setRememberedState(pageResponse)

    // The request may have been cancelled while the response was being prepared,
    // for example when the user navigated back or a visit to another page committed
    if (this.requestParams.wasCancelledAtAll()) {
      return
    }

    // A redirect decides where the visit lands, so we compare against the page the server returned
    const currentPageUrl = hrefToUrl(this.context.page.get().url)
    const responseUrl = hrefToUrl(pageResponse.url)
    const leavesPage = this.requestParams.leavesPage(currentPageUrl, responseUrl)

    const keepsCurrentUrl = this.keepsCurrentUrl(currentPageUrl, responseUrl)

    this.requestParams.setPreserveOptions(pageResponse)

    const queryMethodData = this.queryMethodData(pageResponse)

    if (queryMethodData) {
      pageResponse.queryMethodData = queryMethodData
    }

    pageResponse.url =
      this.context.history.preserveUrl || this.context.navigation.external || keepsCurrentUrl
        ? this.context.page.get().url
        : this.pageUrl(pageResponse)

    this.requestParams.all().onBeforeUpdate(pageResponse)

    const visit = this.requestParams.all()

    return this.context.page.set(pageResponse, {
      replace: visit.replace,
      preserveScroll: visit.preserveScroll as boolean,
      preserveState: visit.preserveState as boolean,
      viewTransition: visit.viewTransition,
      cached: visit.cached,
      visitId: visit.id,
      isCancelled: () => this.requestParams.wasCancelledAtAll(),
      onCommit: () => {
        this.pageApplied = true

        // The page is only left once it's replaced, a dropped visit leaves its requests running
        if (leavesPage) {
          this.context.eventHandler.fireInternalEvent('leavePage', currentPageUrl)
        }
      },
    })
  }

  protected queryMethodData(pageResponse: Page): Page['queryMethodData'] {
    const { method, data, url, preserveUrl } = this.requestParams.all()

    // Redirects (e.g. after a failed validation) are followed with GET,
    // so their pages don't carry the QUERY request data.
    const wasRenderedByQuery =
      method === 'query' &&
      !isFormData(data) &&
      isSameUrlWithoutHash(hrefToUrl(pageResponse.url), url) &&
      Object.keys(pageResponse.props.errors ?? {}).length === 0

    if (!wasRenderedByQuery) {
      return undefined
    }

    // Like reload data on a GET page, it becomes part of the page unless the URL is preserved (e.g. infinite scroll).
    return this.requestParams.isQueryMethodReload() && preserveUrl ? this.context.page.get().queryMethodData : data
  }

  protected getDataFromResponse(response: any): any {
    if (typeof response !== 'string') {
      return response
    }

    try {
      return parsePage(response)
    } catch (error) {
      return response
    }
  }

  protected shouldSetPage(pageResponse: Page): boolean {
    if (!this.requestParams.all().async) {
      // If the request is sync, we should always set the page
      return true
    }

    if (this.originatingPage.component !== pageResponse.component) {
      // We originated from a component but the response re-directed us,
      // we should respect the redirection and set the page
      return true
    }

    // At this point, if the originating request component is different than the current component,
    // the user has since navigated and we should discard the response
    if (this.originatingPage.component !== this.context.page.get().component) {
      return false
    }

    const originatingUrl = hrefToUrl(this.originatingPage.url)
    const currentPageUrl = hrefToUrl(this.context.page.get().url)

    // We have the same component, let's double-check the URL
    // If we're no longer on the same path name (e.g. /users/1 -> /users/2), we should not set the page
    return originatingUrl.origin === currentPageUrl.origin && originatingUrl.pathname === currentPageUrl.pathname
  }

  /**
   * A client visit, like the URL updates of <InfiniteScroll>, may change the query string while a reload of the
   * page is in flight. The reload then keeps that URL instead of putting the previous query string back.
   */
  protected keepsCurrentUrl(currentPageUrl: URL, responseUrl: URL): boolean {
    const visit = this.requestParams.all()

    if (!visit.async) {
      return false
    }

    const originatingUrl = hrefToUrl(this.originatingPage.url)

    const reloadsOriginatingPage = isSameUrlWithoutHash(visit.url, originatingUrl)
    const urlChangedSince = !isSameUrlWithoutHash(currentPageUrl, originatingUrl)
    const landsOnCurrentPath = isSameUrlWithoutQueryOrHash(responseUrl, currentPageUrl)

    return reloadsOriginatingPage && urlChangedSince && landsOnCurrentPath
  }

  protected pageUrl(pageResponse: Page) {
    const responseUrl = hrefToUrl(pageResponse.url)

    if (pageResponse.preserveFragment) {
      responseUrl.hash = this.requestParams.all().url.hash
    } else {
      setHashIfSameUrl(this.requestParams.all().url, responseUrl)
    }

    return responseUrl.pathname + responseUrl.search + responseUrl.hash
  }

  protected preserveOptimisticProps(pageResponse: Page): void {
    if (!this.context.router.hasPendingOptimistic() && !this.isStaleOptimisticResponse()) {
      return
    }

    for (const key of Object.keys(pageResponse.props)) {
      if (this.context.page.hasBaseline(key)) {
        this.context.page.updateBaseline(key, pageResponse.props[key])
        pageResponse.props[key] = this.context.page.get().props[key]
      }
    }
  }

  protected isStaleOptimisticResponse(): boolean {
    // An optimistic request that started later has already been confirmed, so these
    // props were read before that write and would roll it back on screen
    return this.optimisticId !== null && this.context.page.hasConfirmedOptimisticAfter(this.optimisticId)
  }

  protected preserveEqualProps(pageResponse: Page): void {
    if (pageResponse.component !== this.context.page.get().component) {
      return
    }

    const currentPageProps = this.context.page.get().props

    Object.entries(pageResponse.props).forEach(([key, value]) => {
      if (isEqual(value, currentPageProps[key])) {
        pageResponse.props[key] = currentPageProps[key]
      }
    })
  }

  protected mergeProps(pageResponse: Page): void {
    if (!this.requestParams.isPartial() || pageResponse.component !== this.context.page.get().component) {
      return
    }

    const propsToAppend = pageResponse.mergeProps || []
    const propsToPrepend = pageResponse.prependProps || []
    const propsToDeepMerge = pageResponse.deepMergeProps || []
    const matchPropsOn = pageResponse.matchPropsOn || []

    const mergeProp = (prop: string, shouldAppend: boolean) => {
      const currentProp = get(this.context.page.get().props, prop)
      const incomingProp = get(pageResponse.props, prop)

      if (Array.isArray(incomingProp)) {
        const newArray = this.mergeOrMatchItems(
          (currentProp || []) as any[],
          incomingProp,
          prop,
          matchPropsOn,
          shouldAppend,
        )

        set(pageResponse.props, prop, newArray)
      } else if (typeof incomingProp === 'object' && incomingProp !== null) {
        const newObject = {
          ...(currentProp || {}),
          ...incomingProp,
        }

        set(pageResponse.props, prop, newObject)
      }
    }

    propsToAppend.forEach((prop) => mergeProp(prop, true))
    propsToPrepend.forEach((prop) => mergeProp(prop, false))

    propsToDeepMerge.forEach((prop) => {
      const currentProp = get(this.context.page.get().props, prop)
      const incomingProp = get(pageResponse.props, prop)

      // Function to recursively merge objects and arrays
      const deepMerge = (target: any, source: any, matchProp: string) => {
        if (Array.isArray(source)) {
          return this.mergeOrMatchItems(target, source, matchProp, matchPropsOn)
        }

        if (typeof source === 'object' && source !== null) {
          // Merge objects by iterating over keys
          return Object.keys(source).reduce(
            (acc, key) => {
              acc[key] = deepMerge(target ? target[key] : undefined, source[key], `${matchProp}.${key}`)
              return acc
            },
            { ...target },
          )
        }

        // If the source is neither an array nor an object, simply return it
        return source
      }

      // Apply the deep merge and update the page response
      set(pageResponse.props, prop, deepMerge(currentProp, incomingProp, prop))
    })

    const nestedTopKeys = new Set(
      [...this.requestParams.all().only, ...this.requestParams.all().except]
        .filter((prop) => prop.includes('.'))
        .map((prop) => prop.split('.')[0]),
    )
    for (const key of nestedTopKeys) {
      const currentValue = this.context.page.get().props[key]

      if (this.isObject(currentValue) && this.isObject(pageResponse.props[key])) {
        pageResponse.props[key] = this.deepMergeObjects(currentValue as PageProps, pageResponse.props[key] as PageProps)
      }
    }

    pageResponse.props = {
      ...this.context.page.get().props,
      ...pageResponse.props,
    }

    if (this.shouldPreserveErrors(pageResponse)) {
      pageResponse.props.errors = this.context.page.get().props.errors
    }

    // Preserve the existing scrollProps
    if (this.context.page.get().scrollProps) {
      pageResponse.scrollProps = {
        ...(this.context.page.get().scrollProps || {}),
        ...(pageResponse.scrollProps || {}),
      }
    }

    // Preserve the existing onceProps
    if (this.context.page.hasOnceProps()) {
      pageResponse.onceProps = {
        ...(this.context.page.get().onceProps || {}),
        ...(pageResponse.onceProps || {}),
      }
    }

    // Preserve flash data on deferred props requests (background fetches that replay
    // the same flash from the initial load), but let regular partial reloads use
    // whatever the server sent (which may be empty, clearing stale flash)
    if (this.requestParams.isDeferredPropsRequest()) {
      pageResponse.flash = { ...this.context.page.get().flash }
    }

    const currentOriginalDeferred = this.context.page.get().initialDeferredProps
    if (currentOriginalDeferred && Object.keys(currentOriginalDeferred).length > 0) {
      pageResponse.initialDeferredProps = currentOriginalDeferred
    }

    pageResponse.rescuedProps = this.mergeRescuedProps(pageResponse)
  }

  protected mergeRescuedProps(pageResponse: Page): string[] {
    const currentRescued = this.context.page.get().rescuedProps ?? []
    const incomingRescued = pageResponse.rescuedProps ?? []

    const newRescued = new Set(
      currentRescued.filter((prop) => !partialReloadRequestsProp(this.requestParams.all(), prop)),
    )

    incomingRescued.forEach((prop) => newRescued.add(prop))

    return Array.from(newRescued)
  }

  /**
   * By default, the Laravel adapter shares validation errors via Inertia::always(),
   * so responses always include errors, even when empty. Components like
   * InfiniteScroll and WhenVisible, as well as loading deferred props,
   * perform async requests that should practically never reset errors.
   */
  protected shouldPreserveErrors(pageResponse: Page): boolean {
    if (!this.requestParams.all().preserveErrors) {
      return false
    }

    const currentErrors = this.context.page.get().props.errors

    if (!currentErrors || Object.keys(currentErrors).length === 0) {
      return false
    }

    const responseErrors = pageResponse.props.errors

    if (responseErrors && Object.keys(responseErrors).length > 0) {
      return false
    }

    return true
  }

  protected isObject(item: any): boolean {
    return item && typeof item === 'object' && !Array.isArray(item)
  }

  protected deepMergeObjects(target: PageProps, source: PageProps): PageProps {
    const result = { ...target }

    for (const key of Object.keys(source)) {
      const targetValue = target[key]
      const sourceValue = source[key]

      if (this.isObject(targetValue) && this.isObject(sourceValue)) {
        result[key] = this.deepMergeObjects(targetValue as PageProps, sourceValue as PageProps)
      } else {
        result[key] = sourceValue
      }
    }

    return result
  }

  protected mergeOrMatchItems(
    existingItems: any[],
    newItems: any[],
    matchProp: string,
    matchPropsOn: string[],
    shouldAppend = true,
  ) {
    const items = Array.isArray(existingItems) ? existingItems : []

    // Find the matching key for this specific property path
    const matchingKey = matchPropsOn.find((key) => {
      const keyPath = key.split('.').slice(0, -1).join('.')

      return keyPath === matchProp
    })

    // If no matching key is configured, simply concatenate the arrays
    if (!matchingKey) {
      return shouldAppend ? [...items, ...newItems] : [...newItems, ...items]
    }

    // Extract the property name we'll use to match items (e.g., 'id' from 'users.data.id')
    const uniqueProperty = matchingKey.split('.').pop() || ''

    // Create a map of new items by their unique property lookups
    const newItemsMap = new Map()

    newItems.forEach((item) => {
      if (this.hasUniqueProperty(item, uniqueProperty)) {
        newItemsMap.set(item[uniqueProperty], item)
      }
    })

    return shouldAppend
      ? this.appendWithMatching(items, newItems, newItemsMap, uniqueProperty)
      : this.prependWithMatching(items, newItems, newItemsMap, uniqueProperty)
  }

  protected appendWithMatching(
    existingItems: any[],
    newItems: any[],
    newItemsMap: Map<any, any>,
    uniqueProperty: string,
  ): any[] {
    // Update existing items with new values, keep non-matching items
    const updatedExisting = existingItems.map((item) => {
      if (this.hasUniqueProperty(item, uniqueProperty) && newItemsMap.has(item[uniqueProperty])) {
        return newItemsMap.get(item[uniqueProperty])
      }

      return item
    })

    // Filter new items to only include those not already in existing items
    const newItemsToAdd = newItems.filter((item) => {
      if (!this.hasUniqueProperty(item, uniqueProperty)) {
        return true // Always add items without unique property
      }

      return !existingItems.some(
        (existing) =>
          this.hasUniqueProperty(existing, uniqueProperty) && existing[uniqueProperty] === item[uniqueProperty],
      )
    })

    return [...updatedExisting, ...newItemsToAdd]
  }

  protected prependWithMatching(
    existingItems: any[],
    newItems: any[],
    newItemsMap: Map<any, any>,
    uniqueProperty: string,
  ): any[] {
    // Filter existing items, keeping only those not being updated
    const untouchedExisting = existingItems.filter((item) => {
      if (this.hasUniqueProperty(item, uniqueProperty)) {
        return !newItemsMap.has(item[uniqueProperty])
      }

      return true
    })

    return [...newItems, ...untouchedExisting]
  }

  protected hasUniqueProperty(item: any, property: string): boolean {
    return item && typeof item === 'object' && property in item
  }

  protected async setRememberedState(pageResponse: Page): Promise<void> {
    const rememberedState = await this.context.history.getState<Page['rememberedState']>(
      this.context.history.rememberedState,
      {},
    )

    if (
      this.requestParams.all().preserveState &&
      rememberedState &&
      pageResponse.component === this.context.page.get().component
    ) {
      pageResponse.rememberedState = rememberedState
    }
  }

  protected getScopedErrors(errors: Errors & ErrorBag): Errors {
    if (!this.requestParams.all().errorBag) {
      return errors
    }

    return errors[this.requestParams.all().errorBag || ''] || {}
  }
}
