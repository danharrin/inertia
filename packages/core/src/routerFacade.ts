import { Router } from './router'
import { RouterContext } from './routerContext'
import { getCurrentContext, publishContext } from './routerGraph'
import type { RouterInitParams } from './types'

// The facade must not retain the first mount's state after that mount is disposed.
const target = Object.create(Router.prototype) as Router
const forwarders = new WeakMap<Function, (...args: unknown[]) => unknown>()
let attempt = 0
let initialized = false

Object.setPrototypeOf(getCurrentContext().router, target)

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

  if (initialized) {
    nextOwner.live.inherit(getCurrentContext().live)
  }

  initialized = true
  Object.setPrototypeOf(nextOwner.router, target)
  publishContext(nextOwner)

  return (Router.prototype.init<ComponentType>).call(nextOwner.router, params)
}

export const router = new Proxy(target, {
  get(target, property, receiver) {
    if (Object.hasOwn(target, property)) {
      return Reflect.get(target, property, receiver)
    }

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

    if (!forwarders.has(value)) {
      forwarders.set(value, function (this: Router | void, ...args: unknown[]) {
        const isPublicCall = !(this instanceof Router) || this === router
        const internalRouter = isPublicCall ? getCurrentContext().router : this
        const result = Reflect.apply(value, internalRouter, args)

        return isPublicCall && result === internalRouter ? router : result
      })
    }

    return forwarders.get(value)
  },
})
