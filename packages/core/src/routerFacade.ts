import { Router } from './router'
import { RouterContext } from './routerContext'
import { getCurrentContext, publishContext } from './routerGraph'
import type { RouterInitParams } from './types'

const target = getCurrentContext().router
const forwarders = new Map<PropertyKey, (...args: unknown[]) => unknown>()
let attempt = 0
let initialized = false

const init = <ComponentType>(params: RouterInitParams<ComponentType>): VoidFunction => {
  const currentAttempt = ++attempt

  if (initialized) {
    getCurrentContext().dispose()
  }

  if (currentAttempt !== attempt) {
    return () => {}
  }

  // The adapters decrypt history before the first init. Keep that initial state.
  const nextOwner = initialized ? new RouterContext() : getCurrentContext()

  if (initialized && !params.externalNavigation && !getCurrentContext().navigation.external) {
    nextOwner.history.inherit(getCurrentContext().history)
  }

  initialized = true
  publishContext(nextOwner)

  return nextOwner.router.init(params)
}

export const router = new Proxy(target, {
  get(target, property, receiver) {
    if (property === 'init') {
      return init
    }

    if (property === 'activePolls') {
      return getCurrentContext().router.activePolls
    }

    const value = Reflect.get(target, property, receiver)

    if (typeof value !== 'function' || !(property in Router.prototype)) {
      return value
    }

    if (!forwarders.has(property)) {
      forwarders.set(property, (...args: unknown[]) => {
        const internalRouter = getCurrentContext().router
        const result = Reflect.apply(
          internalRouter[property as keyof Router] as (...args: unknown[]) => unknown,
          internalRouter,
          args,
        )

        return result === internalRouter ? router : result
      })
    }

    return forwarders.get(property)
  },
})
