import { Config } from './config'
import { Router } from './router'
import { router } from './routerFacade'
import { getCurrentContext } from './routerGraph'
import type { LiveOption } from './types'

export { UseFormUtils } from './useFormUtils'

export { axiosAdapter } from './axiosHttpClient'
export { config } from './config'
export { getInitialPageFromDOM, getScrollableParent } from './domUtils'
export { hasFiles } from './files'
export { objectToFormData } from './formData'
export { formDataToObject } from './formObject'
export { default as createHeadManager, resolveServerHead } from './head'
export { http } from './http'
export { HttpCancelledError, HttpError, HttpNetworkError, HttpResponseError } from './httpErrors'
export { default as useInfiniteScroll } from './infiniteScroll'
/** @internal Not part of the public API. May change or be removed without notice. */
export { exposeInterceptors, interceptors } from './interceptors'
export {
  createLayoutPropsStore,
  isPropsObject,
  isPropsObjectOrCallback,
  normalizeLayouts,
  type LayoutCallbackReturn,
  type LayoutDefinition,
  type LayoutPropsStore,
} from './layout'
export { shouldIntercept, shouldNavigate } from './navigationEvents'
export { isPathOrSubPath, partialReloadRequestsProp, partialReloadRequestsSomeProps } from './partialReload'
export { progress, default as setupProgress } from './progress'
export { FormComponentResetSymbol, resetFormFields } from './resetFormFields'
export { socketId } from './socketId'
export { buildSSRBody } from './ssrUtils'
export * from './types'
export {
  hrefToUrl,
  isSameUrlWithoutQueryOrHash,
  isUrlMethodPair,
  mergeDataIntoQueryString,
  resolveUrlMethodPairComponent,
  urlHasProtocol,
  urlToString,
  urlWithoutHash,
} from './url'
export { XhrHttpClient, xhrHttpClient } from './xhrHttpClient'
export { type Config, type Router }

export { router }

export const configureLive = (option: LiveOption): void => getCurrentContext().live.configure(option)

/** The write side stays private so callers cannot register visits they never finish. */
export const propRefreshes = {
  isRefreshing: (prop: string): boolean => getCurrentContext().propRefreshes.isRefreshing(prop),
  onChange: (listener: VoidFunction): VoidFunction => getCurrentContext().propRefreshes.onChange(listener),
}
