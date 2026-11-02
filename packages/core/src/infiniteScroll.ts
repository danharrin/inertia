import { requestAnimationFrame } from './domUtils'
import { useInfiniteScrollData } from './infiniteScroll/data'
import { useInfiniteScrollElementManager } from './infiniteScroll/elements'
import { useInfiniteScrollQueryString } from './infiniteScroll/queryString'
import { useInfiniteScrollPreservation } from './infiniteScroll/scrollPreservation'
import { getCurrentContext } from './routerGraph'
import { Page, ReloadOptions, UseInfiniteScrollOptions, UseInfiniteScrollProps } from './types'

/**
 * Core infinite scroll composable that orchestrates data fetching, DOM management,
 * scroll preservation, and URL synchronization.
 *
 * This is the main entry point that coordinates four sub-systems:
 * - Data management: Handles pagination state and server requests
 * - Element management: DOM observation and intersection detection
 * - Query string sync: Updates URL as user scrolls through pages
 * - Scroll preservation: Maintains scroll position during content updates
 */
export default function useInfiniteScroll(options: UseInfiniteScrollOptions): UseInfiniteScrollProps {
  const context = getCurrentContext()
  const queryStringManager = useInfiniteScrollQueryString({
    ...options,
    getPageName: () => dataManager.getPageName(),
  })

  // Create scroll preservation callbacks that capture and restore scroll position
  // and restore it after new content is prepended to maintain visual stability
  const scrollPreservation = useInfiniteScrollPreservation(options)

  const elementManager = useInfiniteScrollElementManager({
    ...options,
    // As items enter viewport, update URL to reflect the most visible page
    onItemIntersected: queryStringManager.onItemIntersected,
    onPreviousTriggered: () => dataManager.fetchPrevious(),
    onNextTriggered: () => dataManager.fetchNext(),
  })

  const dataManager = useInfiniteScrollData({
    ...options,
    // Before updating page data, tag any manually added DOM elements
    // so they don't get confused with server-loaded content
    onBeforeUpdate: elementManager.processManuallyAddedElements,
    // After successful request, tag new server content
    onCompletePreviousRequest: (_, details) => {
      if (!context.navigation.active) {
        return
      }

      options.onCompletePreviousRequest(details)

      if (details.completed) {
        requestAnimationFrame(
          context.callback(() => elementManager.processServerLoadedElements(details.page)),
          2,
        )
      }
    },
    onCompleteNextRequest: (_, details) => {
      if (!context.navigation.active) {
        return
      }

      options.onCompleteNextRequest(details)

      if (details.completed) {
        requestAnimationFrame(
          context.callback(() => elementManager.processServerLoadedElements(details.page)),
          2,
        )
      }
    },
    onReset: options.onDataReset,
  })

  const addScrollPreservationCallbacks = (reloadOptions: ReloadOptions): ReloadOptions => {
    const { captureScrollPosition, restoreScrollPosition } = scrollPreservation.createCallbacks()

    const originalOnBeforeUpdate = reloadOptions.onBeforeUpdate || (() => {})
    const originalOnSuccess = reloadOptions.onSuccess || (() => {})

    reloadOptions.onBeforeUpdate = (page: Page) => {
      originalOnBeforeUpdate(page)
      captureScrollPosition()
    }

    reloadOptions.onSuccess = (page: Page) => {
      originalOnSuccess(page)
      restoreScrollPosition()
    }

    return reloadOptions
  }

  const originalFetchNext = dataManager.fetchNext
  dataManager.fetchNext = (reloadOptions: ReloadOptions = {}) => {
    if (!context.navigation.active) {
      return
    }

    reloadOptions = { ...options.getReloadOptions?.(), ...reloadOptions }

    if (options.inReverseMode()) {
      reloadOptions = addScrollPreservationCallbacks(reloadOptions)
    }

    originalFetchNext(reloadOptions)
  }

  const originalFetchPrevious = dataManager.fetchPrevious
  dataManager.fetchPrevious = (reloadOptions: ReloadOptions = {}) => {
    if (!context.navigation.active) {
      return
    }

    reloadOptions = { ...options.getReloadOptions?.(), ...reloadOptions }

    if (!options.inReverseMode()) {
      reloadOptions = addScrollPreservationCallbacks(reloadOptions)
    }

    originalFetchPrevious(reloadOptions)
  }

  const removeEventListener = context.router.on(
    'success',
    context.callback(() => requestAnimationFrame(context.callback(elementManager.refreshTriggers), 2)),
  )

  return {
    dataManager,
    elementManager,
    flush: () => {
      removeEventListener()
      dataManager.flush()
      elementManager.flushAll()
      queryStringManager.cancel()
    },
  }
}
