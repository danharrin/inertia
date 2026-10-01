import debounce from '../debounce'
import { getElementsInViewportFromCollection } from '../domUtils'
import { getCurrentContext } from '../routerGraph'
import { hrefToUrl, urlHasProtocol, urlToString } from '../url'
import { getPageFromElement } from './elements'

/**
 * As users scroll through infinite content, this system updates the URL to reflect
 * which page they're currently viewing. It uses a "most visible page" calculation
 * so that the URL reflects whichever page has the most visible items.
 */
export const useInfiniteScrollQueryString = (options: {
  getPageName: () => string
  getItemsElement: () => HTMLElement
  shouldPreserveUrl: () => boolean
}) => {
  const context = getCurrentContext()
  let enabled = true

  const queuePageUpdate = (page: string) => {
    context.infiniteScrollQueue
      .add(() => {
        return new Promise((resolve) => {
          if (!enabled || !context.navigation.active || context.navigation.external) {
            context.infiniteScrollInitialUrl = context.infiniteScrollPayloadUrl = null
            return resolve()
          }

          if (!context.infiniteScrollInitialUrl || !context.infiniteScrollPayloadUrl) {
            const currentPageUrl = context.page.get().url
            context.infiniteScrollInitialUrl = hrefToUrl(currentPageUrl)
            context.infiniteScrollPayloadUrl = hrefToUrl(currentPageUrl)
            context.infiniteScrollInitialUrlWasAbsolute = urlHasProtocol(currentPageUrl)
          }

          const pageName = options.getPageName()
          const searchParams = context.infiniteScrollPayloadUrl.searchParams

          // Clean URLs: don't show ?page=1 in the URL, just remove the parameter entirely
          if (page === '1') {
            searchParams.delete(pageName)
          } else {
            searchParams.set(pageName, page)
          }

          setTimeout(() => resolve())
        })
      })
      .finally(() => {
        if (
          enabled &&
          context.navigation.active &&
          !context.navigation.external &&
          context.infiniteScrollInitialUrl &&
          context.infiniteScrollPayloadUrl &&
          context.infiniteScrollInitialUrl.href !== context.infiniteScrollPayloadUrl.href &&
          context.infiniteScrollInitialUrlWasAbsolute !== null
        ) {
          // Update URL without triggering a page reload or affecting scroll position
          context.router.replace({
            url: urlToString(context.infiniteScrollPayloadUrl, context.infiniteScrollInitialUrlWasAbsolute),
            preserveScroll: true,
            preserveState: true,
          })
        }

        context.infiniteScrollInitialUrl =
          context.infiniteScrollPayloadUrl =
          context.infiniteScrollInitialUrlWasAbsolute =
            null
      })
  }

  // Debounced to avoid excessive URL updates during fast scrolling
  const onItemIntersected = debounce((itemElement: HTMLElement) => {
    const itemsElement = options.getItemsElement()

    if (
      !enabled ||
      !context.navigation.active ||
      context.navigation.external ||
      options.shouldPreserveUrl() ||
      !itemElement ||
      !itemsElement
    ) {
      return
    }

    // Count how many items from each page are currently visible in the viewport
    const pageMap = new Map<string, number>()
    const elements = [...itemsElement.children] as HTMLElement[]

    getElementsInViewportFromCollection(elements, itemElement).forEach((element) => {
      const page = getPageFromElement(element) ?? '1'

      if (pageMap.has(page)) {
        pageMap.set(page, pageMap.get(page)! + 1)
      } else {
        pageMap.set(page, 1)
      }
    })

    // Find the page with the most visible items - this becomes the "current" page
    const sortedPages = Array.from(pageMap.entries()).sort((a, b) => b[1] - a[1])
    const mostVisiblePage = sortedPages[0]?.[0]

    if (mostVisiblePage !== undefined) {
      queuePageUpdate(mostVisiblePage)
    }
  }, 250)

  return {
    onItemIntersected,
    cancel: () => (enabled = false),
  }
}
