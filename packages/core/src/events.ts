import type { RouterContext } from './routerContext'
import { GlobalEventDetails, GlobalEventNames, GlobalEventTrigger } from './types'

export function createEvents(context: RouterContext) {
  function fireEvent<TEventName extends GlobalEventNames>(
    name: TEventName,
    options: CustomEventInit<GlobalEventDetails<TEventName>>,
  ): boolean {
    if (!context.navigation.active && name !== 'finish') {
      return false
    }

    const result = document.dispatchEvent(new CustomEvent(`inertia:${name}`, options))

    return context.navigation.active && result
  }

  const fireBeforeEvent: GlobalEventTrigger<'before'> = (visit) => {
    return fireEvent('before', { cancelable: true, detail: { visit } })
  }

  const fireErrorEvent: GlobalEventTrigger<'error'> = (errors, { page, visitId } = {}) => {
    return fireEvent('error', { detail: { errors, page, visitId } })
  }

  const fireNetworkErrorEvent: GlobalEventTrigger<'networkError'> = (error) => {
    return fireEvent('networkError', { cancelable: true, detail: { error } })
  }

  const fireFinishEvent: GlobalEventTrigger<'finish'> = (visit) => {
    return fireEvent('finish', { detail: { visit } })
  }

  const fireHttpExceptionEvent: GlobalEventTrigger<'httpException'> = (response) => {
    return fireEvent('httpException', { cancelable: true, detail: { response } })
  }

  const fireBeforeUpdateEvent: GlobalEventTrigger<'beforeUpdate'> = (page) => {
    return fireEvent('beforeUpdate', { detail: { page } })
  }

  const fireNavigateEvent: GlobalEventTrigger<'navigate'> = (page, { cached = false, visitId } = {}) => {
    return fireEvent('navigate', { detail: { page, cached, visitId } })
  }

  const fireClientVisitEvent: GlobalEventTrigger<'clientVisit'> = (page, { replace, visitId }) => {
    return fireEvent('clientVisit', { detail: { page, replace, visitId } })
  }

  const fireProgressEvent: GlobalEventTrigger<'progress'> = (progress) => {
    return fireEvent('progress', { detail: { progress } })
  }

  const fireStartEvent: GlobalEventTrigger<'start'> = (visit) => {
    return fireEvent('start', { detail: { visit } })
  }

  const fireSuccessEvent: GlobalEventTrigger<'success'> = (page, { visitId } = {}) => {
    return fireEvent('success', { detail: { page, visitId } })
  }

  const firePrefetchedEvent: GlobalEventTrigger<'prefetched'> = (response, visit) => {
    return fireEvent('prefetched', { detail: { fetchedAt: Date.now(), response, visit } })
  }

  const firePrefetchingEvent: GlobalEventTrigger<'prefetching'> = (visit) => {
    return fireEvent('prefetching', { detail: { visit } })
  }

  const fireFlashEvent: GlobalEventTrigger<'flash'> = (flash) => {
    return fireEvent('flash', { detail: { flash } })
  }

  const fireLocationEvent: GlobalEventTrigger<'location'> = (url, versionChange) => {
    return fireEvent('location', { cancelable: true, detail: { url, versionChange } })
  }

  return {
    fireBeforeEvent,
    fireErrorEvent,
    fireNetworkErrorEvent,
    fireFinishEvent,
    fireHttpExceptionEvent,
    fireBeforeUpdateEvent,
    fireNavigateEvent,
    fireClientVisitEvent,
    fireProgressEvent,
    fireStartEvent,
    fireSuccessEvent,
    firePrefetchedEvent,
    firePrefetchingEvent,
    fireFlashEvent,
    fireLocationEvent,
  }
}
